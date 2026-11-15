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
import { TranslationPanel } from '../src/renderer/src/translate/TranslationPanel'
import { TranslationPaneToggle } from '../src/renderer/src/translate/TranslationPaneToggle'
import {
  dismissSourceChanged,
  markSourceChanged,
} from '../src/renderer/src/translate/source-change-notice'
import { LocaleProvider } from '../src/renderer/src/locale'
import { DEFAULT_SORT, writeSessionSort } from '../src/renderer/src/translate/project-table'

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
    writingStyle: {
      serialComma: 'default',
      quotePunctuation: 'default',
      italics: 'default',
      custom: '',
    },
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
    sourceCount: 0,
    referenceCount: 0,
    ...patch,
  }
}

beforeEach(() => {
  writeSessionSort(DEFAULT_SORT)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  api = {
    list: vi.fn().mockResolvedValue([]),
    recent: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({ dir: '/p/new' }),
    remove: vi.fn().mockResolvedValue(undefined),
    getSystemPrompt: vi.fn().mockResolvedValue('global'),
    setSystemPrompt: vi.fn().mockResolvedValue(undefined),
    getProject: vi.fn().mockResolvedValue(project()),
    rename: vi.fn(async ({ name }: { name: string }) => ({ ...project(), name })),
    updateSettings: vi.fn(async ({ patch }: { patch: object }) => ({ ...project(), ...patch })),
    addMaterial: vi.fn(),
    removeMaterial: vi.fn(),
    pickMaterials: vi.fn().mockResolvedValue(null),
    pickParentDir: vi.fn().mockResolvedValue(null),
    openTranslation: vi
      .fn()
      .mockResolvedValue({ flow: 'edit', sourceTabId: 't1', outputTabId: 't2', hashStatus: 'ok' }),
    setPaneHidden: vi.fn().mockResolvedValue(undefined),
    pickExisting: vi.fn().mockResolvedValue(null),
    relocate: vi.fn().mockResolvedValue(null),
    referenceStatus: vi.fn().mockResolvedValue({}),
    referenceText: vi.fn().mockResolvedValue({ text: '', truncated: false }),
    pictureInfo: vi.fn().mockResolvedValue([]),
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
  it('a project card shows its language pair and the source and reference counts', async () => {
    api.list.mockResolvedValue([
      entry({ dir: '/p/ok', name: 'Fine', sourceCount: 3, referenceCount: 2 }),
    ])
    await render(ProjectList, { onOpen: vi.fn() })
    const row = host.querySelector('[role="row"][data-project-dir]') as HTMLElement
    expect(row).not.toBeNull()
    const cells = [...row.querySelectorAll('[role="cell"]')].map((c) => c.textContent)
    expect(cells[2]).toBe('3')
    expect(cells[3]).toBe('2')
    expect(row.querySelector('.translate-chip')).not.toBeNull()
    expect(row.textContent).toContain('/p/ok')
  })

  it('with no projects the empty state offers the new project action', async () => {
    await render(ProjectList, { onOpen: vi.fn() })
    const empty = host.querySelector('[data-empty-projects]') as HTMLElement
    expect(empty).not.toBeNull()
    expect(empty.textContent).toContain('No translation projects yet')
    expect(within(empty, 'New project')).toBeTruthy()
  })

  it('list shows not-found projects as disabled with a remove button', async () => {
    api.list.mockResolvedValue([
      entry({ dir: '/p/ok', name: 'Fine' }),
      entry({ dir: '/p/gone', name: 'Gone', status: 'not-found' }),
    ])
    await render(ProjectList, { onOpen: vi.fn() })
    const rows = host.querySelectorAll('[role="row"][data-project-dir]')
    expect(rows).toHaveLength(2)
    const gone = host.querySelector('[data-project-dir="/p/gone"]') as HTMLElement
    expect(gone.classList.contains('is-broken')).toBe(true)
    expect(gone.querySelector('[data-tt-primary]')).toBeNull()
    await openMenu(gone)
    await click(menuItem(gone, 'Remove from list'))
    expect(api.remove).toHaveBeenCalledWith({ dir: '/p/gone', deleteFolder: false })
  })

  it('delete asks whether to remove only from the list or also the folder', async () => {
    api.list.mockResolvedValue([entry({ dir: '/p/ok', name: 'Fine' })])
    await render(ProjectList, { onOpen: vi.fn() })
    await openMenu(host.querySelector('[data-project-dir]') as HTMLElement)
    await click(buttonByText('Delete'))
    expect(buttonByText('Remove from list only')).toBeTruthy()
    // the folder choice needs a second explicit confirmation before anything is sent
    await click(buttonByText('Remove from list and delete folder'))
    expect(api.remove).not.toHaveBeenCalled()
    await click(buttonByText('Delete folder permanently'))
    expect(api.remove).toHaveBeenCalledWith({ dir: '/p/ok', deleteFolder: true })
  })

  it('opens an existing project folder through main and then opens it', async () => {
    const onOpen = vi.fn()
    api.pickExisting.mockResolvedValue({ dir: '/p/moved', name: 'Moved', contextLinked: true })
    await render(ProjectList, { onOpen })
    await click(buttonByText('Open existing project folder'))
    expect(api.pickExisting).toHaveBeenCalledWith()
    expect(onOpen).toHaveBeenCalledWith('/p/moved')
    expect(api.list).toHaveBeenCalledTimes(2)
  })

  it('says so when the opened folder could not be linked for the AI panels', async () => {
    const onOpen = vi.fn()
    api.pickExisting.mockResolvedValue({ dir: '/p/f', name: 'F', contextLinked: false })
    await render(ProjectList, { onOpen })
    await click(buttonByText('Open existing project folder'))
    expect(host.textContent).toContain('holds AI instructions or memory from elsewhere')
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('a cancelled pick changes nothing; a non-project folder shows a localized error', async () => {
    const onOpen = vi.fn()
    await render(ProjectList, { onOpen })
    await click(buttonByText('Open existing project folder'))
    expect(onOpen).not.toHaveBeenCalled()
    api.pickExisting.mockRejectedValue(new Error('[NOT_A_PROJECT] not a translation project: /x'))
    await click(buttonByText('Open existing project folder'))
    expect(host.textContent).toContain('This folder is not a translation project.')
    expect(host.textContent).not.toContain('/x')
  })

  it('a not-found row offers to locate the folder', async () => {
    api.list.mockResolvedValue([entry({ dir: '/p/gone', name: 'Gone', status: 'not-found' })])
    api.relocate.mockResolvedValue({ dir: '/p/here', name: 'Gone', contextLinked: true })
    await render(ProjectList, { onOpen: vi.fn() })
    const gone = host.querySelector('[data-project-dir]') as HTMLElement
    await openMenu(gone)
    await click(menuItem(gone, 'Locate folder…'))
    expect(api.relocate).toHaveBeenCalledWith({ dir: '/p/gone' })
    expect(api.list).toHaveBeenCalledTimes(2)
  })

  it('a refused folder delete (documents open) shows the localized reason', async () => {
    api.list.mockResolvedValue([entry({ dir: '/p/ok', name: 'Fine' })])
    api.remove.mockRejectedValue(new Error('[PROJECT_IN_USE] documents of this project are open'))
    await render(ProjectList, { onOpen: vi.fn() })
    await openMenu(host.querySelector('[data-project-dir]') as HTMLElement)
    await click(buttonByText('Delete'))
    await click(buttonByText('Remove from list and delete folder'))
    await click(buttonByText('Delete folder permanently'))
    expect(host.textContent).toContain('Documents from this project are open.')
  })

  it('list-only delete never deletes the folder', async () => {
    api.list.mockResolvedValue([entry({ dir: '/p/ok', name: 'Fine' })])
    await render(ProjectList, { onOpen: vi.fn() })
    await openMenu(host.querySelector('[data-project-dir]') as HTMLElement)
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
      sourceLang: 'ko',
      targetLang: 'en',
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

async function openMenu(row: HTMLElement) {
  await click(row.querySelector('button[aria-haspopup="menu"]')!)
}

function menuItem(row: HTMLElement, text: string): HTMLButtonElement {
  const found = [...row.querySelectorAll('[role="menuitem"]')].find(
    (b) => b.textContent?.trim() === text,
  )
  if (!found) throw new Error(`no menu item "${text}"`)
  return found as HTMLButtonElement
}

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
    expect(api.updateSettings).toHaveBeenCalledWith({
      dir: '/p/a',
      patch: { ocr: { kind: 'off' } },
    })
    await act(async () => {
      setValue(select, 'chatgpt')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(api.updateSettings).toHaveBeenLastCalledWith({
      dir: '/p/a',
      patch: { ocr: { kind: 'ai', provider: 'chatgpt' } },
    })
  })

  it('project prompt saves on blur through update-settings only', async () => {
    await render(ProjectDetail, props())
    const area = host.querySelector('textarea') as HTMLTextAreaElement
    await typeInto(area, 'formal tone')
    expect(api.updateSettings).not.toHaveBeenCalled()
    await blur(area)
    expect(api.updateSettings).toHaveBeenCalledWith({
      dir: '/p/a',
      patch: { projectPrompt: 'formal tone' },
    })
  })

  it('a blur-save during a pending upload does not drop the new entry', async () => {
    let finishAdd!: (p: ProjectFile) => void
    let finishSave!: (p: ProjectFile) => void
    api.pickMaterials.mockResolvedValue({ token: 't', names: ['new.txt'] })
    api.addMaterial.mockReturnValue(new Promise<ProjectFile>((r) => (finishAdd = r)))
    api.updateSettings.mockReturnValue(new Promise<ProjectFile>((r) => (finishSave = r)))
    await render(ProjectDetail, props())
    const section = host.querySelector('[data-material-kind="reference"]') as HTMLElement
    await click(within(section, 'Add files'))
    const area = host.querySelector('textarea') as HTMLTextAreaElement
    await typeInto(area, 'p')
    await blur(area)
    // the settings answer (old lists) lands first, then the upload answer
    await act(async () => finishSave(project({ projectPrompt: 'p' })))
    expect(section.textContent).not.toContain('new.txt')
    await act(async () => finishAdd(project({ references: ['new.txt'] })))
    expect(section.textContent).toContain('new.txt')
    expect(area.value).toBe('p')
  })

  it('a settings answer that lands after an upload answer keeps the new entry', async () => {
    let finishSave!: (p: ProjectFile) => void
    api.pickMaterials.mockResolvedValue({ token: 't', names: ['new.txt'] })
    api.addMaterial.mockResolvedValue(project({ references: ['new.txt'] }))
    api.updateSettings.mockReturnValue(new Promise<ProjectFile>((r) => (finishSave = r)))
    await render(ProjectDetail, props())
    const area = host.querySelector('textarea') as HTMLTextAreaElement
    await typeInto(area, 'p')
    await blur(area)
    const section = host.querySelector('[data-material-kind="reference"]') as HTMLElement
    await click(within(section, 'Add files'))
    expect(section.textContent).toContain('new.txt')
    await act(async () => finishSave(project({ projectPrompt: 'p' })))
    expect(section.textContent).toContain('new.txt')
  })

  it('a failed prompt save keeps the text and shows an unsaved state', async () => {
    api.updateSettings.mockRejectedValueOnce(new Error('[PROJECT_FILE_INVALID] x'))
    await render(ProjectDetail, props())
    const area = host.querySelector('textarea') as HTMLTextAreaElement
    await typeInto(area, 'keep me')
    await blur(area)
    expect(area.value).toBe('keep me')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('damaged')
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Not saved')
    await blur(area)
    expect(api.updateSettings).toHaveBeenCalledTimes(2)
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Saved')
  })

  it('a multi-file upload that fails midway names the files already added', async () => {
    api.pickMaterials.mockResolvedValue({ token: 't', names: ['a.txt', 'b.txt'] })
    api.addMaterial
      .mockResolvedValueOnce(project({ references: ['a.txt'] }))
      .mockRejectedValueOnce(new Error('[UNSUPPORTED_SOURCE] nope'))
    await render(ProjectDetail, props())
    const section = host.querySelector('[data-material-kind="reference"]') as HTMLElement
    await click(within(section, 'Add files'))
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'Added before the error: a.txt',
    )
    expect(section.textContent).toContain('a.txt')
  })

  const twoSources = () =>
    project({
      sources: [
        { file: 'a.docx', sha256: 'x', kind: 'editable' },
        { file: 'b.docx', sha256: 'y', kind: 'editable' },
      ],
    })

  it('every source row has its own button that opens that file', async () => {
    api.getProject.mockResolvedValue(twoSources())
    const p = props()
    await render(ProjectDetail, p)
    const sources = host.querySelector('[data-material-kind="source"]') as HTMLElement
    const rows = sources.querySelectorAll('[role="row"][data-file]')
    expect(rows).toHaveLength(2)
    await click(rows[1]!.querySelector('[aria-label="Open translation: b.docx"]')!)
    expect(p.onStartTranslation).toHaveBeenCalledWith('b.docx')
    expect(host.querySelector('[data-material-kind="reference"] [data-file]')).toBeNull()
  })

  it('global start is disabled for zero and for several sources', async () => {
    const p = props()
    await render(ProjectDetail, p)
    expect(buttonByText('Start translation').disabled).toBe(true)
    act(() => root.unmount())
    root = createRoot(host)
    api.getProject.mockResolvedValue(twoSources())
    await render(ProjectDetail, p)
    expect(buttonByText('Start translation').disabled).toBe(true)
    expect(host.textContent).toContain('Several documents added')
    await click(buttonByText('Start translation'))
    expect(p.onStartTranslation).not.toHaveBeenCalled()
  })

  it('global start passes the file when exactly one source exists', async () => {
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

describe('ProjectDetail reference status', () => {
  const props = () => ({ dir: '/p/a', onBack: vi.fn(), onStartTranslation: vi.fn() })

  it('shows each reference’s conversion status', async () => {
    api.getProject.mockResolvedValue(
      project({ references: ['a.docx', 'scan.pdf', 'bad.hwp', 'x.zip', 'link.txt'] }),
    )
    api.referenceStatus.mockResolvedValue({
      'a.docx': 'converted',
      'scan.pdf': 'needs-ocr',
      'bad.hwp': 'failed',
      'x.zip': 'unsupported',
      'link.txt': 'outside',
    })
    await render(ProjectDetail, props())
    expect(api.referenceStatus).toHaveBeenCalledWith('/p/a')
    const status = (file: string) =>
      host
        .querySelector(`[data-reference-status][data-file="${file}"]`)
        ?.getAttribute('data-reference-status')
    expect(status('a.docx')).toBe('converted')
    expect(status('scan.pdf')).toBe('needs-ocr')
    expect(status('bad.hwp')).toBe('failed')
    expect(status('x.zip')).toBe('unsupported')
    const section = host.querySelector('[data-material-kind="reference"]')!
    expect(section.textContent).toContain('Converted to text')
    expect(section.textContent).toContain('Needs OCR')
    expect(section.textContent).toContain('Could not be read')
    expect(section.textContent).toContain('Not used: a link out of the project')
    // only a converted reference offers its text
    expect(section.querySelectorAll('[data-action="view-converted"]')).toHaveLength(1)
  })

  it('opens the converted text read-only and closes it', async () => {
    api.getProject.mockResolvedValue(project({ references: ['a.docx'] }))
    api.referenceStatus.mockResolvedValue({ 'a.docx': 'converted' })
    api.referenceText.mockResolvedValue({ text: '# Terms\n\nengine', truncated: false })
    await render(ProjectDetail, props())
    await click(host.querySelector('[data-action="view-converted"]')!)
    expect(api.referenceText).toHaveBeenCalledWith({ dir: '/p/a', file: 'a.docx' })
    const dialog = host.querySelector('[role="dialog"]')!
    expect(dialog.querySelector('pre')?.textContent).toBe('# Terms\n\nengine')
    // nothing in it can be edited or saved
    expect(dialog.querySelectorAll('textarea, input, [contenteditable="true"]')).toHaveLength(0)
    expect([...dialog.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Close'])
    await click(buttonByText('Close'))
    expect(host.querySelector('[role="dialog"]')).toBeNull()
  })

  it('reads the statuses again after a reference was added', async () => {
    api.getProject.mockResolvedValue(project())
    api.pickMaterials.mockResolvedValue({ token: 't', names: ['n.md'] })
    api.addMaterial.mockResolvedValue(project({ references: ['n.md'] }))
    await render(ProjectDetail, props())
    api.referenceStatus.mockResolvedValue({ 'n.md': 'converted' })
    const section = host.querySelector('[data-material-kind="reference"]')!
    await click([...section.querySelectorAll('button')].at(-1)!)
    expect(api.referenceStatus).toHaveBeenCalledTimes(2)
    expect(
      host
        .querySelector('[data-reference-status][data-file="n.md"]')
        ?.getAttribute('data-reference-status'),
    ).toBe('converted')
  })
})

describe('ProjectDetail picture notice', () => {
  const props = () => ({ dir: '/p/a', onBack: vi.fn(), onStartTranslation: vi.fn() })

  it('offers embedded OCR separately from translation for DOCX and XLSX sources', async () => {
    api.getProject.mockResolvedValue(
      project({
        sources: [
          { file: 'a.docx', kind: 'editable', sha256: 'x' },
          { file: 'b.xlsx', kind: 'editable', sha256: 'y' },
        ],
      }),
    )
    api.pictureInfo.mockResolvedValue([
      { file: 'a.docx', kind: 'source', pictures: 0 },
      { file: 'b.xlsx', kind: 'source', pictures: 3 },
    ])
    const onStartOcr = vi.fn()
    await render(ProjectDetail, { ...props(), onStartOcr })
    const buttons = [...host.querySelectorAll('button[data-action="embedded-ocr"]')]
    expect(buttons).toHaveLength(2)
    await click(buttons[1]!)
    expect(onStartOcr).toHaveBeenCalledWith('b.xlsx')
    expect(api.openTranslation).not.toHaveBeenCalled()
  })

  it('offers OCR for the Hangul sources too and says their pictures can be read with it', async () => {
    api.getProject.mockResolvedValue(
      project({
        sources: [
          { file: 'form.hwpx', kind: 'editable', sha256: 'x' },
          { file: 'old.hwp', kind: 'editable', sha256: 'y' },
          { file: 'notes.md', kind: 'editable', sha256: 'z' },
        ],
      }),
    )
    api.pictureInfo.mockResolvedValue([{ file: 'form.hwpx', kind: 'source', pictures: 4 }])
    const onStartOcr = vi.fn()
    await render(ProjectDetail, { ...props(), onStartOcr })
    const buttons = [...host.querySelectorAll('button[data-action="embedded-ocr"]')]
    expect(buttons).toHaveLength(2)
    await click(buttons[0]!)
    expect(onStartOcr).toHaveBeenCalledWith('form.hwpx')
    const hint = host.querySelector('[data-picture-notice][data-file="form.hwpx"]')!
    expect(hint.textContent).toContain('Use OCR to read all or selected images')
    expect(hint.textContent).not.toContain('does not read pictures inside this file')
  })

  it('says next to a file that its pictures need OCR and will not be translated', async () => {
    api.getProject.mockResolvedValue(
      project({
        sources: [
          { file: 'a.docx', sha256: 'x', kind: 'editable' },
          { file: 'plain.docx', sha256: 'y', kind: 'editable' },
        ],
        references: ['r.pptx', 'r.pdf'],
      }),
    )
    api.pictureInfo.mockResolvedValue([
      { file: 'a.docx', kind: 'source', pictures: 3 },
      { file: 'plain.docx', kind: 'source', pictures: 0 },
      { file: 'r.pptx', kind: 'reference', pictures: 2 },
      { file: 'r.pdf', kind: 'reference', pictures: null },
    ])
    await render(ProjectDetail, props())
    expect(api.pictureInfo).toHaveBeenCalledWith('/p/a')
    const notice = (kind: string, file: string) =>
      host.querySelector(
        `[data-material-kind="${kind}"] [data-picture-notice][data-file="${file}"]`,
      )
    const a = notice('source', 'a.docx')!
    expect(a.getAttribute('data-picture-notice')).toBe('3')
    expect(a.textContent).toContain('Pictures in this document: 3')
    expect(a.textContent).toContain('will not be translated')
    expect(a.textContent).toContain('OCR')
    expect(a.textContent).toContain('Use OCR to read all or selected images')
    expect(notice('reference', 'r.pptx')?.textContent).toContain('Pictures in this file: 2')
    // no pictures, or unknown: no notice
    expect(notice('source', 'plain.docx')).toBeNull()
    expect(notice('reference', 'r.pdf')).toBeNull()
  })

  it('no notice when the count fails or the bridge has no such call', async () => {
    api.getProject.mockResolvedValue(
      project({ sources: [{ file: 'a.docx', sha256: 'x', kind: 'editable' }] }),
    )
    api.pictureInfo.mockRejectedValue(new Error('[UNKNOWN] nope'))
    await render(ProjectDetail, props())
    expect(host.querySelector('[data-picture-notice]')).toBeNull()
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  it('drops a stale notice when a later count fails', async () => {
    api.getProject.mockResolvedValue(
      project({ sources: [{ file: 'a.docx', sha256: 'x', kind: 'editable' }] }),
    )
    api.pictureInfo.mockResolvedValue([{ file: 'a.docx', kind: 'source', pictures: 2 }])
    api.removeMaterial.mockResolvedValue(project())
    await render(ProjectDetail, props())
    expect(host.querySelector('[data-picture-notice][data-file="a.docx"]')).not.toBeNull()
    api.pictureInfo.mockRejectedValue(new Error('[UNKNOWN] nope'))
    await click(host.querySelector('[data-action="delete-file"]')!)
    expect(api.pictureInfo).toHaveBeenCalledTimes(2)
    expect(host.querySelector('[data-picture-notice]')).toBeNull()
  })

  it('counts again when the lists are reloaded', async () => {
    api.getProject.mockResolvedValue(
      project({ sources: [{ file: 'a.docx', sha256: 'x', kind: 'editable' }] }),
    )
    api.pictureInfo.mockResolvedValue([{ file: 'a.docx', kind: 'source', pictures: 2 }])
    const base = props()
    await render(ProjectDetail, base)
    expect(host.querySelector('[data-picture-notice]')).not.toBeNull()
    api.pictureInfo.mockResolvedValue([{ file: 'a.docx', kind: 'source', pictures: 0 }])
    await render(ProjectDetail, { ...base, listsVersion: 1 })
    expect(api.pictureInfo).toHaveBeenCalledTimes(2)
    expect(host.querySelector('[data-picture-notice]')).toBeNull()
  })

  it('counts again after a file was added', async () => {
    api.getProject.mockResolvedValue(project())
    api.pickMaterials.mockResolvedValue({ token: 't', names: ['n.docx'] })
    api.addMaterial.mockResolvedValue(
      project({ sources: [{ file: 'n.docx', sha256: 'z', kind: 'editable' }] }),
    )
    await render(ProjectDetail, props())
    api.pictureInfo.mockResolvedValue([{ file: 'n.docx', kind: 'source', pictures: 1 }])
    const section = host.querySelector('[data-material-kind="source"]')!
    await click([...section.querySelectorAll('button')].at(-1)!)
    expect(api.pictureInfo).toHaveBeenCalledTimes(2)
    expect(host.querySelector('[data-picture-notice][data-file="n.docx"]')).not.toBeNull()
  })
})

describe('TranslationPanel (opening the translation view)', () => {
  async function openDetail() {
    api.list.mockResolvedValue([entry({ dir: '/p/a', name: 'A' })])
    api.getProject.mockResolvedValue(
      project({ sources: [{ file: 'a.docx', sha256: 'x', kind: 'editable' }] }),
    )
    await render(TranslationPanel, {})
    await click(host.querySelector('[data-tt-primary]')!)
  }

  it('asks main to open the chosen file of this project', async () => {
    await openDetail()
    await click(host.querySelector('[data-action="open-translation"]')!)
    expect(api.openTranslation).toHaveBeenCalledWith({ dir: '/p/a', file: 'a.docx' })
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(host.querySelector('[role="status"]')).toBeNull()
  })

  it('warns when the source copy changed since it was added', async () => {
    api.openTranslation.mockResolvedValue({
      flow: 'edit',
      sourceTabId: 't1',
      outputTabId: 't2',
      hashStatus: 'changed',
    })
    await openDetail()
    await click(host.querySelector('[data-action="open-translation"]')!)
    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      'The source copy has changed',
    )
  })

  it('shows a localized error, not the raw Electron text', async () => {
    api.openTranslation.mockRejectedValue(
      new Error(
        "Error invoking remote method 'translate:open-translation': Error: [SOURCE_MISSING] gone",
      ),
    )
    await openDetail()
    await click(host.querySelector('[data-action="open-translation"]')!)
    const alert = host.querySelector('[role="alert"]')?.textContent ?? ''
    expect(alert).toContain('source copy is missing')
    expect(alert).not.toContain('invoking')
  })
})

describe('TranslationPaneToggle', () => {
  const tabs = [
    {
      id: 'src',
      kind: 'docs' as const,
      title: 'a.docx',
      closable: true,
      active: false,
      readOnly: true as const,
    },
    { id: 'out', kind: 'docs' as const, title: 'a.docx', closable: true, active: true },
  ]
  const split = {
    aTabId: 'src',
    bTabId: 'out',
    orientation: 'side' as const,
    ratio: 0.5,
    focus: 'b' as const,
    collapsed: null,
  }

  it('is absent for an ordinary split', async () => {
    await render(TranslationPaneToggle, {
      split,
      tabs: tabs.map((t) => ({ ...t, readOnly: undefined })),
    })
    expect(host.querySelector('[role="group"]')).toBeNull()
  })

  it('hides the source pane, then offers to show it again', async () => {
    await render(TranslationPaneToggle, { split, tabs })
    await click(buttonByText('Hide source'))
    expect(api.setPaneHidden).toHaveBeenCalledWith({ side: 'left', hidden: true })
    await render(TranslationPaneToggle, { split: { ...split, collapsed: 'a' }, tabs })
    expect(buttonByText('Show source').getAttribute('aria-pressed')).toBe('true')
    await click(buttonByText('Show source'))
    expect(api.setPaneHidden).toHaveBeenLastCalledWith({ side: 'left', hidden: false })
    await click(buttonByText('Hide translation'))
    expect(api.setPaneHidden).toHaveBeenLastCalledWith({ side: 'right', hidden: true })
  })
})

describe('changed-source notice in the tab strip', () => {
  const tabs = [
    {
      id: 't1',
      kind: 'docs' as const,
      title: 'a.docx',
      closable: true,
      active: false,
      readOnly: true as const,
    },
    { id: 't2', kind: 'docs' as const, title: 'a.docx', closable: true, active: true },
  ]
  const split = {
    aTabId: 't1',
    bTabId: 't2',
    orientation: 'side' as const,
    ratio: 0.5,
    focus: 'b' as const,
    collapsed: null,
  }

  // the store is module state: an earlier test may have marked t1
  beforeEach(() => dismissSourceChanged('t1'))
  afterEach(() => dismissSourceChanged('t1'))

  it('is absent while the source copy matched its hash', async () => {
    await render(TranslationPaneToggle, { split, tabs })
    expect(host.querySelector('.translate-source-notice')).toBeNull()
  })

  it('shows over the split after opening a changed source, and can be dismissed', async () => {
    api.openTranslation.mockResolvedValue({
      flow: 'edit',
      sourceTabId: 't1',
      outputTabId: 't2',
      hashStatus: 'changed',
    })
    api.list.mockResolvedValue([entry({ dir: '/p/a', name: 'A' })])
    api.getProject.mockResolvedValue(
      project({ sources: [{ file: 'a.docx', sha256: 'x', kind: 'editable' }] }),
    )
    await render(TranslationPanel, {})
    await click(host.querySelector('[data-tt-primary]')!)
    await click(host.querySelector('[data-action="open-translation"]')!)
    // the tab strip is another part of the same renderer
    act(() => root.unmount())
    root = createRoot(host)
    await render(TranslationPaneToggle, { split, tabs })
    const notice = host.querySelector('.translate-source-notice')
    expect(notice?.textContent).toContain('Source copy changed')
    expect(notice?.getAttribute('title')).toContain('The source copy has changed')
    await click(host.querySelector('[aria-label="Dismiss"]')!)
    expect(host.querySelector('.translate-source-notice')).toBeNull()
  })

  it('belongs to that source tab only', async () => {
    markSourceChanged('other')
    await render(TranslationPaneToggle, { split, tabs })
    expect(host.querySelector('.translate-source-notice')).toBeNull()
    dismissSourceChanged('other')
  })
})

describe('ProjectList table', () => {
  const names = () =>
    [...host.querySelectorAll('[role="row"][data-project-dir] .tt-title')].map((e) => e.textContent)
  const three = () => [
    entry({ dir: '/p/b', name: 'beta', lastOpened: 5 }),
    entry({ dir: '/p/a', name: 'Alpha', lastOpened: 9 }),
    entry({ dir: '/p/c', name: 'gamma', lastOpened: 1 }),
  ]

  it('is a table with a header and sorts newest first by default', async () => {
    api.list.mockResolvedValue(three())
    await render(ProjectList, { onOpen: vi.fn() })
    expect(host.querySelector('[role="table"] [role="row"] [role="columnheader"]')).not.toBeNull()
    expect(names()).toEqual(['Alpha', 'beta', 'gamma'])
    const headers = [...host.querySelectorAll('.tt-projects [role="columnheader"]')]
    expect(
      headers.find((h) => h.getAttribute('aria-sort') === 'descending')?.textContent,
    ).toContain('Last opened')
  })

  it('sorts by name on click, flips on a second click, and remembers it for the session', async () => {
    api.list.mockResolvedValue(three())
    await render(ProjectList, { onOpen: vi.fn() })
    await click(host.querySelector('[aria-label="Sort by Name"]')!)
    expect(names()).toEqual(['Alpha', 'beta', 'gamma'])
    await click(host.querySelector('[aria-label="Sort by Name"]')!)
    expect(names()).toEqual(['gamma', 'beta', 'Alpha'])
    act(() => root.unmount())
    root = createRoot(host)
    await render(ProjectList, { onOpen: vi.fn() })
    expect(names()).toEqual(['gamma', 'beta', 'Alpha'])
    await click(host.querySelector('[aria-label="Sort by Last opened"]')!)
    expect(names()).toEqual(['Alpha', 'beta', 'gamma'])
  })

  it('opens a project from anywhere on its row and from the name button', async () => {
    const onOpen = vi.fn()
    api.list.mockResolvedValue([entry({ dir: '/p/ok', name: 'Fine' })])
    await render(ProjectList, { onOpen })
    await click(host.querySelector('[role="row"][data-project-dir] .tt-lang')!)
    expect(onOpen).toHaveBeenCalledWith('/p/ok')
    onOpen.mockClear()
    const primary = host.querySelector('[data-tt-primary]') as HTMLButtonElement
    expect(primary.textContent).toBe('Fine')
    await click(primary)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('arrow keys move between the rows', async () => {
    api.list.mockResolvedValue(three())
    await render(ProjectList, { onOpen: vi.fn() })
    const buttons = [...host.querySelectorAll('[data-tt-primary]')] as HTMLButtonElement[]
    buttons[0]!.focus()
    await act(async () => {
      buttons[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(document.activeElement).toBe(buttons[1])
    await act(async () => {
      buttons[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    })
    expect(document.activeElement).toBe(buttons[0])
  })

  async function startRename(dir: string) {
    const row = host.querySelector(`[data-project-dir="${dir}"]`) as HTMLElement
    await openMenu(row)
    await click(menuItem(row, 'Rename'))
    return host.querySelector('[data-rename-input]') as HTMLInputElement
  }

  async function press(el: Element, key: string) {
    await act(async () => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    })
  }

  function typeName(input: HTMLInputElement, value: string) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  }

  it('Rename in the row menu edits in place; Enter saves the trimmed name and reloads', async () => {
    api.list.mockResolvedValue([entry({ dir: '/p/ok', name: 'Fine' })])
    const onOpen = vi.fn()
    await render(ProjectList, { onOpen })
    const input = await startRename('/p/ok')
    expect(input.value).toBe('Fine')
    typeName(input, '  New name  ')
    await press(input, 'Enter')
    expect(api.rename).toHaveBeenCalledWith({ dir: '/p/ok', name: 'New name' })
    expect(api.list).toHaveBeenCalledTimes(2)
    expect(host.querySelector('[data-rename-input]')).toBeNull()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('Escape cancels without saving; an unchanged name is not sent', async () => {
    api.list.mockResolvedValue([entry({ dir: '/p/ok', name: 'Fine' })])
    await render(ProjectList, { onOpen: vi.fn() })
    let input = await startRename('/p/ok')
    typeName(input, 'Other')
    await press(input, 'Escape')
    expect(api.rename).not.toHaveBeenCalled()
    expect(host.querySelector('[data-rename-input]')).toBeNull()
    input = await startRename('/p/ok')
    await press(input, 'Enter')
    expect(api.rename).not.toHaveBeenCalled()
  })

  it('leaving the field saves; an empty name shows the notice and sends nothing', async () => {
    api.list.mockResolvedValue([entry({ dir: '/p/ok', name: 'Fine' })])
    await render(ProjectList, { onOpen: vi.fn() })
    let input = await startRename('/p/ok')
    typeName(input, 'Blurred')
    await act(async () => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(api.rename).toHaveBeenCalledWith({ dir: '/p/ok', name: 'Blurred' })
    api.rename.mockClear()
    input = await startRename('/p/ok')
    typeName(input, '   ')
    await press(input, 'Enter')
    expect(api.rename).not.toHaveBeenCalled()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('1 to 80 characters')
  })
})

describe('ProjectDetail table and settings', () => {
  const props = () => ({ dir: '/p/a', onBack: vi.fn(), onStartTranslation: vi.fn() })
  const oneSource = () =>
    project({ sources: [{ file: 'a.docx', sha256: 'x', kind: 'editable' }], references: ['r.txt'] })

  it('clicking the file name opens the translation, and the explicit action still does', async () => {
    api.getProject.mockResolvedValue(oneSource())
    const p = props()
    await render(ProjectDetail, p)
    const title = host.querySelector('[data-material-kind="source"] [data-action="open-title"]')!
    expect(title.textContent).toBe('a.docx')
    await click(title)
    expect(p.onStartTranslation).toHaveBeenCalledWith('a.docx')
    p.onStartTranslation.mockClear()
    await click(host.querySelector('[data-action="open-translation"]')!)
    expect(p.onStartTranslation).toHaveBeenCalledWith('a.docx')
  })

  it('clicking the rest of a row, or a reference name, opens nothing', async () => {
    api.getProject.mockResolvedValue(oneSource())
    const p = props()
    await render(ProjectDetail, p)
    await click(host.querySelector('[data-material-kind="source"] .tt-status')!)
    await click(host.querySelector('[data-material-kind="source"] .tt-glyph')!)
    await click(host.querySelector('[data-material-kind="reference"] .tt-title')!)
    expect(p.onStartTranslation).not.toHaveBeenCalled()
    expect(
      host.querySelector('[data-material-kind="reference"] [data-action="open-title"]'),
    ).toBeNull()
  })

  it('shows Name and Status columns and a status chip per file', async () => {
    api.getProject.mockResolvedValue(oneSource())
    api.referenceStatus.mockResolvedValue({ 'r.txt': 'converted' })
    await render(ProjectDetail, props())
    const table = host.querySelector('[data-material-kind="source"] [role="table"]') as HTMLElement
    const heads = [...table.querySelectorAll('[role="columnheader"]')].map((h) => h.textContent)
    expect(heads.slice(0, 2)).toEqual(['Name', 'Status'])
    expect(table.querySelector('[data-status="ready"]')?.textContent).toBe('Ready')
    expect(host.querySelector('[data-reference-status="converted"]')).not.toBeNull()
  })

  it('the title renames in place with a Saved indicator; Escape cancels', async () => {
    api.getProject.mockResolvedValue(oneSource())
    await render(ProjectDetail, props())
    await click(host.querySelector('[data-action="rename-title"]')!)
    let input = host.querySelector('[data-rename-input]') as HTMLInputElement
    expect(input.value).toBe('Book')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'Renamed',
    )
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(api.rename).toHaveBeenCalledWith({ dir: '/p/a', name: 'Renamed' })
    expect(host.querySelector('.translate-title')?.textContent).toBe('Renamed')
    expect(host.querySelector('[data-rename-saved]')?.textContent).toBe('Saved')
    // the project's other settings are untouched
    expect(api.updateSettings).not.toHaveBeenCalled()
    await click(host.querySelector('.translate-title-text')!)
    input = host.querySelector('[data-rename-input]') as HTMLInputElement
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Nope')
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(api.rename).toHaveBeenCalledTimes(1)
    expect(host.querySelector('.translate-title')?.textContent).toBe('Renamed')
  })

  it('writing style: three numbered options per question, each with an example', async () => {
    await render(ProjectDetail, props())
    const card = host.querySelector('[data-style-card]') as HTMLElement
    const serial = card.querySelectorAll('[data-style-question="serialComma"] .tt-option')
    expect(serial).toHaveLength(3)
    expect([...serial].map((o) => o.querySelector('.tt-option-num')?.textContent)).toEqual([
      '1',
      '2',
      '3',
    ])
    expect(serial[0]!.textContent).toContain('apples, carrots, and pears')
    expect(serial[1]!.textContent).toContain('apples, carrots and pears')
    const quote = card.querySelectorAll('[data-style-question="quotePunctuation"] .tt-option')
    expect(quote[0]!.textContent).toContain('"apples", "carrots"')
    expect(quote[1]!.textContent).toContain('"apples," "carrots,"')
    // the default (follow the target language) is selected for a project without a choice
    expect(
      (card.querySelector('[data-style-option="serialComma:default"] input') as HTMLInputElement)
        .checked,
    ).toBe(true)
  })

  it('choosing an option saves the whole style through update-settings and says Saved', async () => {
    await render(ProjectDetail, props())
    await click(host.querySelector('[data-style-option="serialComma:with"] input')!)
    expect(api.updateSettings).toHaveBeenCalledWith({
      dir: '/p/a',
      patch: {
        writingStyle: {
          serialComma: 'with',
          quotePunctuation: 'default',
          italics: 'default',
          custom: '',
        },
      },
    })
    expect(host.querySelector('[data-style-card] [role="status"]')?.textContent).toBe('Saved')
    expect(
      (host.querySelector('[data-style-option="serialComma:with"] input') as HTMLInputElement)
        .checked,
    ).toBe(true)
  })

  it('the italics question offers apply, off and no rule, and saves the choice', async () => {
    await render(ProjectDetail, props())
    const card = host.querySelector('[data-style-card]') as HTMLElement
    const italics = card.querySelectorAll('[data-style-question="italics"] .tt-option')
    expect(italics).toHaveLength(3)
    expect(italics[0]!.textContent).toContain('Apply automatically')
    expect(italics[1]!.textContent).toContain('Do not add italics')
    expect(italics[2]!.textContent).toContain('Follow the source')
    // a project without a stored choice shows the neutral option
    expect(
      (card.querySelector('[data-style-option="italics:default"] input') as HTMLInputElement)
        .checked,
    ).toBe(true)
    await click(host.querySelector('[data-style-option="italics:apply"] input')!)
    expect(api.updateSettings).toHaveBeenCalledWith({
      dir: '/p/a',
      patch: {
        writingStyle: {
          serialComma: 'default',
          quotePunctuation: 'default',
          italics: 'apply',
          custom: '',
        },
      },
    })
  })

  it('the custom instruction saves when the field is left, not on every key', async () => {
    await render(ProjectDetail, props())
    const input = host.querySelector('[data-style-card] input[type="text"]') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'Use British spelling',
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(api.updateSettings).not.toHaveBeenCalled()
    await blur(input)
    expect(api.updateSettings).toHaveBeenCalledWith({
      dir: '/p/a',
      patch: {
        writingStyle: {
          serialComma: 'default',
          quotePunctuation: 'default',
          italics: 'default',
          custom: 'Use British spelling',
        },
      },
    })
  })

  it('a failed style save shows the unsaved state', async () => {
    api.updateSettings.mockRejectedValueOnce(new Error('[PROJECT_FILE_INVALID] x'))
    await render(ProjectDetail, props())
    await click(host.querySelector('[data-style-option="quotePunctuation:inside"] input')!)
    expect(host.querySelector('[data-style-card] [role="status"]')?.textContent).toContain(
      'Not saved',
    )
  })

  it('translation choices: an undecided project shows that the AI will ask, with no Reset', async () => {
    await render(ProjectDetail, props())
    const card = host.querySelector('[data-choices-card]') as HTMLElement
    expect(card.querySelector('h3')?.textContent).toBe('Translation choices')
    expect(card.querySelectorAll('[data-choice]')).toHaveLength(3)
    for (const row of card.querySelectorAll('[data-choice]')) {
      expect(row.textContent).toContain('Not decided yet')
      expect(row.querySelector('button')).toBeNull()
    }
  })

  it('translation choices: a kept answer shows and Reset forgets only that one', async () => {
    api.getProject.mockResolvedValue(
      project({ choices: { outputMode: 'Keep the original', bilingual: 'Two columns' } }),
    )
    await render(ProjectDetail, props())
    const card = host.querySelector('[data-choices-card]') as HTMLElement
    expect(card.querySelector('[data-choice="outputMode"]')?.textContent).toContain(
      'Keep the original',
    )
    expect(card.querySelector('[data-choice="ocrPlacement"] button')).toBeNull()
    await click(card.querySelector('[data-choice="outputMode"] button')!)
    expect(api.updateSettings).toHaveBeenCalledWith({
      dir: '/p/a',
      patch: { choices: { bilingual: 'Two columns' } },
    })
    const after = host.querySelector('[data-choices-card]') as HTMLElement
    expect(after.querySelector('[data-choice="outputMode"]')?.textContent).toContain(
      'Not decided yet',
    )
    expect(after.querySelector('[data-choice="bilingual"]')?.textContent).toContain('Two columns')
  })
})
