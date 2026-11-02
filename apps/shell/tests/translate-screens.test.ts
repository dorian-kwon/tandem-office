/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectFile } from '@genoffice/translate-project'
import type { TranslateApi, TranslateProjectListEntry } from '../src/shared/translate-api'
import { ProjectList } from '../src/renderer/src/translate/ProjectList'
import { ProjectDetail } from '../src/renderer/src/translate/ProjectDetail'
import { LocaleProvider } from '../src/renderer/src/locale'

/**
 * The translation tool's list and detail screens against a fake `translateApi`
 * bridge. The locale is English so button names can be matched by text.
 */

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let api: { [K in keyof TranslateApi]: ReturnType<typeof vi.fn> }

function project(patch: Partial<ProjectFile> = {}): ProjectFile {
  return {
    version: 1,
    name: 'Book',
    sourceLang: 'en',
    targetLang: 'ko',
    projectPrompt: '',
    ocr: { kind: 'ai', provider: 'claude' },
    sources: [],
    references: [],
    glossaryFiles: [],
    ...patch,
  }
}

function entry(patch: Partial<TranslateProjectListEntry>): TranslateProjectListEntry {
  return {
    dir: '/p/a',
    name: 'A',
    status: 'ok',
    sourceLang: 'en',
    targetLang: 'ko',
    lastOpened: 1,
    ...patch,
  }
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  api = {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({ dir: '/p/new' }),
    remove: vi.fn().mockResolvedValue(undefined),
    getSystemPrompt: vi.fn().mockResolvedValue('global'),
    setSystemPrompt: vi.fn().mockResolvedValue(undefined),
    getProject: vi.fn().mockResolvedValue(project()),
    saveProject: vi.fn().mockResolvedValue(undefined),
    addMaterial: vi.fn(),
    removeMaterial: vi.fn(),
    pickMaterials: vi.fn().mockResolvedValue(null),
    pickParentDir: vi.fn().mockResolvedValue(null),
  }
  ;(window as unknown as { translateApi: unknown }).translateApi = api
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  delete (window as unknown as { translateApi?: unknown }).translateApi
})

async function render(node: Parameters<typeof createElement>[0], props: object) {
  await act(async () => {
    root.render(
      createElement(LocaleProvider, { initial: 'en' }, createElement(node as never, props)),
    )
  })
}

function buttonByText(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  if (!found) throw new Error(`no button "${text}"`)
  return found
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function setValue(el: HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement : HTMLTextAreaElement
  Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!.call(el, value)
}

async function typeInto(el: HTMLTextAreaElement, value: string) {
  await act(async () => {
    setValue(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function blur(el: Element) {
  await act(async () => {
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
}

describe('ProjectList', () => {
  it('list shows not-found projects as disabled with a remove button', async () => {
    api.list.mockResolvedValue([
      entry({ dir: '/p/ok', name: 'Fine' }),
      entry({ dir: '/p/gone', name: 'Gone', status: 'not-found' }),
    ])
    await render(ProjectList, { onOpen: vi.fn() })
    const rows = host.querySelectorAll('li.projects-row')
    expect(rows).toHaveLength(2)
    const gone = rows[1] as HTMLElement
    expect(gone.querySelector('[aria-disabled="true"]')).not.toBeNull()
    expect(gone.querySelector('button.translate-open')).toBeNull()
    await click(within(gone, 'Remove from list'))
    expect(api.remove).toHaveBeenCalledWith({ dir: '/p/gone', deleteFolder: false })
  })

  it('delete asks whether to remove only from the list or also the folder', async () => {
    api.list.mockResolvedValue([entry({ dir: '/p/ok', name: 'Fine' })])
    await render(ProjectList, { onOpen: vi.fn() })
    await click(buttonByText('Delete'))
    expect(buttonByText('Remove from list only')).toBeTruthy()
    // the folder choice needs a second explicit confirmation before anything is sent
    await click(buttonByText('Remove from list and delete folder'))
    expect(api.remove).not.toHaveBeenCalled()
    await click(buttonByText('Delete folder permanently'))
    expect(api.remove).toHaveBeenCalledWith({ dir: '/p/ok', deleteFolder: true })
  })

  it('list-only delete never deletes the folder', async () => {
    api.list.mockResolvedValue([entry({ dir: '/p/ok', name: 'Fine' })])
    await render(ProjectList, { onOpen: vi.fn() })
    await click(buttonByText('Delete'))
    await click(buttonByText('Remove from list only'))
    expect(api.remove).toHaveBeenCalledWith({ dir: '/p/ok', deleteFolder: false })
  })

  it('system prompt field saves on blur', async () => {
    await render(ProjectList, { onOpen: vi.fn() })
    const area = host.querySelector('textarea') as HTMLTextAreaElement
    expect(area.value).toBe('global')
    await typeInto(area, 'be terse')
    expect(api.setSystemPrompt).not.toHaveBeenCalled()
    await blur(area)
    expect(api.setSystemPrompt).toHaveBeenCalledWith('be terse')
  })

  it('create goes through the picked parent folder token', async () => {
    api.pickParentDir.mockResolvedValue({ token: 'tok', dir: '/work' })
    const onOpen = vi.fn()
    await render(ProjectList, { onOpen })
    await click(buttonByText('New project'))
    const name = host.querySelector('form input') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Novel')
      name.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(buttonByText('Create').disabled).toBe(true)
    await click(buttonByText('Choose folder'))
    await click(buttonByText('Create'))
    expect(api.create).toHaveBeenCalledWith({
      parentToken: 'tok',
      name: 'Novel',
      sourceLang: 'en',
      targetLang: 'ko',
    })
    expect(onOpen).toHaveBeenCalledWith('/p/new')
  })

  it('shows a localized message, not the raw Electron text', async () => {
    api.pickParentDir.mockResolvedValue({ token: 'tok', dir: '/work' })
    api.create.mockRejectedValue(
      new Error(
        "Error invoking remote method 'translate:create': Error: [PROJECT_EXISTS] project folder already exists: /work/Novel",
      ),
    )
    await render(ProjectList, { onOpen: vi.fn() })
    await click(buttonByText('New project'))
    const name = host.querySelector('form input') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Novel')
      name.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(buttonByText('Choose folder'))
    await click(buttonByText('Create'))
    const alert = host.querySelector('[role="alert"]')
    expect(alert?.textContent).toBe('A project folder with that name already exists there.')
    expect(host.textContent).not.toContain('Electron')
    expect(host.textContent).not.toContain('remote method')
  })
})

function within(el: HTMLElement, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  if (!found) throw new Error(`no button "${text}"`)
  return found
}

describe('ProjectDetail', () => {
  const props = () => ({ dir: '/p/a', onBack: vi.fn(), onStartTranslation: vi.fn() })

  it('detail shows three separate upload lists', async () => {
    api.getProject.mockResolvedValue(
      project({
        sources: [{ file: 'a.docx', sha256: 'x', kind: 'editable' }],
        references: ['ref.txt'],
        glossaryFiles: ['terms.csv'],
      }),
    )
    await render(ProjectDetail, props())
    const sections = host.querySelectorAll('[data-material-kind]')
    expect([...sections].map((e) => e.getAttribute('data-material-kind'))).toEqual([
      'source',
      'reference',
      'glossary',
    ])
    expect(sections[0]?.textContent).toContain('a.docx')
    expect(sections[0]?.textContent).not.toContain('ref.txt')
    expect(sections[1]?.textContent).toContain('ref.txt')
    expect(sections[2]?.textContent).toContain('terms.csv')
  })

  it('each uploaded item has its own delete button', async () => {
    api.getProject.mockResolvedValue(project({ references: ['one.txt', 'two.txt'] }))
    api.removeMaterial.mockResolvedValue(project({ references: ['two.txt'] }))
    await render(ProjectDetail, props())
    const del = host.querySelector('[aria-label="Delete one.txt"]') as HTMLButtonElement
    expect(host.querySelector('[aria-label="Delete two.txt"]')).not.toBeNull()
    await click(del)
    expect(api.removeMaterial).toHaveBeenCalledWith({
      dir: '/p/a',
      kind: 'reference',
      file: 'one.txt',
    })
    expect(host.querySelector('[aria-label="Delete one.txt"]')).toBeNull()
  })

  it('upload adds every picked file by token and index', async () => {
    api.pickMaterials.mockResolvedValue({ token: 't', names: ['a.csv', 'b.csv'] })
    api.addMaterial
      .mockResolvedValueOnce(project({ glossaryFiles: ['a.csv'] }))
      .mockResolvedValueOnce(project({ glossaryFiles: ['a.csv', 'b.csv'] }))
    await render(ProjectDetail, props())
    const section = host.querySelector('[data-material-kind="glossary"]') as HTMLElement
    await click(within(section, 'Add files'))
    expect(api.pickMaterials).toHaveBeenCalledWith('glossary')
    expect(api.addMaterial).toHaveBeenNthCalledWith(2, {
      dir: '/p/a',
      kind: 'glossary',
      token: 't',
      index: 1,
    })
    expect(section.textContent).toContain('b.csv')
  })

  it("OCR select offers only 'AI (Claude)', 'AI (ChatGPT)' and 'Off'", async () => {
    await render(ProjectDetail, props())
    const select = host.querySelector('select[aria-label^="Reading scanned"]') as HTMLSelectElement
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'AI (Claude)',
      'AI (ChatGPT)',
      'Off',
    ])
    await act(async () => {
      setValue(select, 'off')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(api.saveProject).toHaveBeenCalledWith(
      '/p/a',
      expect.objectContaining({ ocr: { kind: 'off' } }),
    )
    await act(async () => {
      setValue(select, 'chatgpt')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(api.saveProject).toHaveBeenLastCalledWith(
      '/p/a',
      expect.objectContaining({ ocr: { kind: 'ai', provider: 'chatgpt' } }),
    )
  })

  it('project prompt saves on blur', async () => {
    await render(ProjectDetail, props())
    const area = host.querySelector('textarea') as HTMLTextAreaElement
    await typeInto(area, 'formal tone')
    expect(api.saveProject).not.toHaveBeenCalled()
    await blur(area)
    expect(api.saveProject).toHaveBeenCalledWith(
      '/p/a',
      expect.objectContaining({ projectPrompt: 'formal tone' }),
    )
  })

  it('start translation is disabled while no source is added', async () => {
    const p = props()
    await render(ProjectDetail, p)
    expect(buttonByText('Start translation').disabled).toBe(true)
    await click(buttonByText('Start translation'))
    expect(p.onStartTranslation).not.toHaveBeenCalled()
  })

  it('start translation passes the source file once one exists', async () => {
    api.getProject.mockResolvedValue(
      project({ sources: [{ file: 'a.docx', sha256: 'x', kind: 'editable' }] }),
    )
    const p = props()
    await render(ProjectDetail, p)
    expect(buttonByText('Start translation').disabled).toBe(false)
    await click(buttonByText('Start translation'))
    expect(p.onStartTranslation).toHaveBeenCalledWith('a.docx')
  })
})
