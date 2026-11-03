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
    recent: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({ dir: '/p/new' }),
    remove: vi.fn().mockResolvedValue(undefined),
    getSystemPrompt: vi.fn().mockResolvedValue('global'),
    setSystemPrompt: vi.fn().mockResolvedValue(undefined),
    getProject: vi.fn().mockResolvedValue(project()),
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
    const gone = host.querySelector('li.projects-row') as HTMLElement
    await click(within(gone, 'Locate folder…'))
    expect(api.relocate).toHaveBeenCalledWith({ dir: '/p/gone' })
    expect(api.list).toHaveBeenCalledTimes(2)
  })

  it('a refused folder delete (documents open) shows the localized reason', async () => {
    api.list.mockResolvedValue([entry({ dir: '/p/ok', name: 'Fine' })])
    api.remove.mockRejectedValue(new Error('[PROJECT_IN_USE] documents of this project are open'))
    await render(ProjectList, { onOpen: vi.fn() })
    await click(buttonByText('Delete'))
    await click(buttonByText('Remove from list and delete folder'))
    await click(buttonByText('Delete folder permanently'))
    expect(host.textContent).toContain('Documents from this project are open.')
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
    const rows = sources.querySelectorAll('li')
    await click(within(rows[1] as HTMLElement, 'Open translation'))
    expect(p.onStartTranslation).toHaveBeenCalledWith('b.docx')
    expect(host.querySelector('[data-material-kind="reference"] li')).toBeNull()
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
      project({ references: ['a.docx', 'scan.pdf', 'bad.hwp', 'x.zip'] }),
    )
    api.referenceStatus.mockResolvedValue({
      'a.docx': 'converted',
      'scan.pdf': 'needs-ocr',
      'bad.hwp': 'failed',
      'x.zip': 'unsupported',
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
    expect(host.querySelector('[data-file="n.md"]')?.getAttribute('data-reference-status')).toBe(
      'converted',
    )
  })
})

describe('TranslationPanel (opening the translation view)', () => {
  async function openDetail() {
    api.list.mockResolvedValue([entry({ dir: '/p/a', name: 'A' })])
    api.getProject.mockResolvedValue(
      project({ sources: [{ file: 'a.docx', sha256: 'x', kind: 'editable' }] }),
    )
    await render(TranslationPanel, {})
    await click(host.querySelector('.translate-open')!)
  }

  it('asks main to open the chosen file of this project', async () => {
    await openDetail()
    await click(buttonByText('Open translation'))
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
    await click(buttonByText('Open translation'))
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
    await click(buttonByText('Open translation'))
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
    await click(host.querySelector('.translate-open')!)
    await click(buttonByText('Open translation'))
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
