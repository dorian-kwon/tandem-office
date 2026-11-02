import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', () => {
  const realpathSync = ((path?: string) => {
    if (path === undefined) return undefined
    if (path === '/real/file' || path === '/canonical/file' || path === '/REAL/FILE')
      return '/real/file'
    return path
  }) as typeof import('node:fs').realpathSync

  realpathSync.native = ((path?: string) => {
    if (path === undefined) return undefined
    if (path === '/real/file' || path === '/canonical/file' || path === '/REAL/FILE')
      return '/real/file'
    return path
  }) as typeof import('node:fs').realpathSync.native

  return { realpathSync }
})

/**
 * TabManager's translation view (Task 9): the hide toggle of a split pane and
 * read-only tabs. The harness is the one of tests/tab-manager.test.ts.
 */

interface FakeWebContents {
  id: number
  on: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  reload: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
  listeners: Map<string, () => void>
  ipc: { handle: ReturnType<typeof vi.fn>; removeHandler: ReturnType<typeof vi.fn> }
}

interface FakeView {
  webContents: FakeWebContents
  setVisible: ReturnType<typeof vi.fn>
  setBounds: ReturnType<typeof vi.fn>
}

let nextWebContentsId = 1

function makeFakeView(): FakeView {
  const listeners = new Map<string, () => void>()
  return {
    webContents: {
      id: nextWebContentsId++,
      listeners,
      on: vi.fn((event: string, handler: () => void) => {
        listeners.set(event, handler)
      }),
      once: vi.fn(),
      close: vi.fn(),
      reload: vi.fn(),
      focus: vi.fn(),
      isDestroyed: vi.fn(() => false),
      ipc: { handle: vi.fn(), removeHandler: vi.fn() },
    },
    setVisible: vi.fn(),
    setBounds: vi.fn(),
  }
}

vi.mock('electron', () => ({
  BrowserWindow: class {},
  // the manual's view is constructed inline in tab-manager (createHelpView),
  // unlike the editor views which arrive through mocked module factories, so
  // the electron mock itself must construct one. Self-contained: no outside
  // references (vi.mock factories run before the module body). The large id
  // stays clear of makeFakeView's counter.
  WebContentsView: class {
    webContents = {
      id: 900001,
      setWindowOpenHandler: () => ({ action: 'deny' as const }),
      // every URL the manual's view loads, for the help-topic tests
      loadURL: (url: string) => {
        ;(globalThis as { __helpLoads?: string[] }).__helpLoads?.push(url)
        return Promise.resolve()
      },
      focus: () => {},
      on: () => {},
      once: () => {},
      close: () => {},
      reload: () => {},
      isDestroyed: () => false,
    }
    setBounds = () => {}
    setVisible = () => {}
  },
}))

const createDocsView = vi.fn(() => makeFakeView())
const docsQueryDirty = vi.fn(() => Promise.resolve(false))
const markDocsNewBlank = vi.fn()
const requestDocsClose = vi.fn(() => Promise.resolve(true))
const setActiveDocsResolver = vi.fn()
const teardownDocsRenderer = vi.fn()

vi.mock('../../docs/src/main/docs-main', () => ({
  createDocsView: (...args: unknown[]) => createDocsView(...(args as [])),
  docsQueryDirty: (...args: unknown[]) => docsQueryDirty(...(args as [])),
  markDocsNewBlank: (...args: unknown[]) => markDocsNewBlank(...args),
  requestDocsClose: (...args: unknown[]) => requestDocsClose(...(args as [])),
  setActiveDocsResolver: (...args: unknown[]) => setActiveDocsResolver(...args),
  teardownDocsRenderer: (...args: unknown[]) => teardownDocsRenderer(...args),
}))

const releaseClosedRenderer = vi.fn(() => true)

vi.mock('../src/main/renderer-disposal', () => ({
  releaseClosedRenderer: (...args: unknown[]) => releaseClosedRenderer(...(args as [])),
}))

const createPdfView = vi.fn(() => makeFakeView())
const pdfIsDirty = vi.fn(() => false)
const clearPdfDirty = vi.fn()
const requestPdfClose = vi.fn(() => Promise.resolve(true))

vi.mock('../../pdf/src/main/pdf-main', () => ({
  createPdfView: (...args: unknown[]) => createPdfView(...(args as [])),
  pdfIsDirty: (...args: unknown[]) => pdfIsDirty(...(args as [])),
  clearPdfDirty: (...args: unknown[]) => clearPdfDirty(...(args as [])),
  requestPdfClose: (...args: unknown[]) => requestPdfClose(...(args as [])),
}))

const createSheetsView = vi.fn(() => makeFakeView())
const nudgeQueuedWorkbook = vi.fn()
const queueWorkbookForView = vi.fn()
const requestSheetsClose = vi.fn(() => Promise.resolve(true))
const setActiveSheetsWebContents = vi.fn()
const setSheetsNewBlank = vi.fn()
const sheetsPendingEditCount = vi.fn(() => 0)

vi.mock('../../sheets/src/main/sheets-main', () => ({
  createSheetsView: (...args: unknown[]) => createSheetsView(...(args as [])),
  nudgeQueuedWorkbook: (...args: unknown[]) => nudgeQueuedWorkbook(...args),
  queueWorkbookForView: (...args: unknown[]) => queueWorkbookForView(...args),
  requestSheetsClose: (...args: unknown[]) => requestSheetsClose(...(args as [])),
  setActiveSheetsWebContents: (...args: unknown[]) => setActiveSheetsWebContents(...args),
  setSheetsNewBlank: (...args: unknown[]) => setSheetsNewBlank(...args),
  sheetsPendingEditCount: (...args: unknown[]) => sheetsPendingEditCount(...(args as [])),
}))

const createSlidesView = vi.fn(() => makeFakeView())
const requestSlidesClose = vi.fn(() => Promise.resolve(true))
const setActiveSlidesWebContents = vi.fn()
const slidesIsDirty = vi.fn(() => false)

vi.mock('../../slides/src/main/slides-main', () => ({
  createSlidesView: (...args: unknown[]) => createSlidesView(...(args as [])),
  requestSlidesClose: (...args: unknown[]) => requestSlidesClose(...(args as [])),
  setActiveSlidesWebContents: (...args: unknown[]) => setActiveSlidesWebContents(...args),
  slidesIsDirty: (...args: unknown[]) => slidesIsDirty(...(args as [])),
}))

const createMarkdownView = vi.fn(() => makeFakeView())
const markdownIsDirty = vi.fn(() => false)
const requestMarkdownClose = vi.fn(() => Promise.resolve(true))

vi.mock('../../markdown/src/main/markdown-main', () => ({
  createMarkdownView: (...args: unknown[]) => createMarkdownView(...(args as [])),
  markdownIsDirty: (...args: unknown[]) => markdownIsDirty(...(args as [])),
  requestMarkdownClose: (...args: unknown[]) => requestMarkdownClose(...(args as [])),
}))

const createHtmlView = vi.fn(() => makeFakeView())
const createHtmlPresentView = vi.fn(() => makeFakeView())
const htmlIsDirty = vi.fn(() => false)
const requestHtmlClose = vi.fn(() => Promise.resolve(true))

vi.mock('../../html/src/main/html-main', () => ({
  createHtmlView: (...args: unknown[]) => createHtmlView(...(args as [])),
  createHtmlPresentView: (...args: unknown[]) => createHtmlPresentView(...(args as [])),
  htmlIsDirty: (...args: unknown[]) => htmlIsDirty(...(args as [])),
  requestHtmlClose: (...args: unknown[]) => requestHtmlClose(...(args as [])),
}))

const createMindmapView = vi.fn(() => makeFakeView())
const mindmapIsDirty = vi.fn(() => false)
const requestMindmapClose = vi.fn(() => Promise.resolve(true))

vi.mock('../../mindmap/src/main/mindmap-main', () => ({
  createMindmapView: (...args: unknown[]) => createMindmapView(...(args as [])),
  mindmapIsDirty: (...args: unknown[]) => mindmapIsDirty(...(args as [])),
  requestMindmapClose: (...args: unknown[]) => requestMindmapClose(...(args as [])),
}))

const createHwpView = vi.fn(() => makeFakeView())
const hwpIsDirty = vi.fn(() => false)
const hwpMemoModalOpen = vi.fn(() => false)
const requestHwpClose = vi.fn(() => Promise.resolve(true))

vi.mock('../../hwp/src/main/hwp-main', () => ({
  createHwpView: (...args: unknown[]) => createHwpView(...(args as [])),
  hwpIsDirty: (...args: unknown[]) => hwpIsDirty(...(args as [])),
  hwpMemoModalOpen: (...args: unknown[]) => hwpMemoModalOpen(...(args as [])),
  requestHwpClose: (...args: unknown[]) => requestHwpClose(...(args as [])),
}))

const createEpubView = vi.fn(() => makeFakeView())
const epubIsDirty = vi.fn(() => false)
const requestEpubClose = vi.fn(() => Promise.resolve(true))

vi.mock('../../epub/src/main/epub-main', () => ({
  createEpubView: (...args: unknown[]) => createEpubView(...(args as [])),
  epubIsDirty: (...args: unknown[]) => epubIsDirty(...(args as [])),
  requestEpubClose: (...args: unknown[]) => requestEpubClose(...(args as [])),
}))

import { TabManager } from '../src/main/tab-manager'

const TAB_STRIP_HEIGHT = 40
const WINDOW_WIDTH = 800
const WINDOW_HEIGHT = 600

interface FakeShellWindow {
  on: ReturnType<typeof vi.fn>
  webContents: { once: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> }
  isDestroyed: ReturnType<typeof vi.fn>
  isFocused: ReturnType<typeof vi.fn>
  getContentBounds: () => { x: number; y: number; width: number; height: number }
  contentView: {
    addChildView: ReturnType<typeof vi.fn>
    removeChildView: ReturnType<typeof vi.fn>
  }
}

function makeShellWindow(): FakeShellWindow {
  return {
    on: vi.fn(),
    webContents: { once: vi.fn(), focus: vi.fn() },
    isDestroyed: vi.fn(() => false),
    isFocused: vi.fn(() => true),
    getContentBounds: () => ({ x: 0, y: 0, width: WINDOW_WIDTH, height: WINDOW_HEIGHT }),
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  }
}

let shellWindow: FakeShellWindow
let onChanged: ReturnType<typeof vi.fn>
let applyMenuFor: ReturnType<typeof vi.fn>
let manager: TabManager

beforeEach(() => {
  vi.clearAllMocks()
  nextWebContentsId = 1
  docsQueryDirty.mockImplementation(() => Promise.resolve(false))
  requestDocsClose.mockImplementation(() => Promise.resolve(true))
  pdfIsDirty.mockImplementation(() => false)
  sheetsPendingEditCount.mockImplementation(() => 0)
  slidesIsDirty.mockImplementation(() => false)
  mindmapIsDirty.mockImplementation(() => false)
  requestMindmapClose.mockImplementation(() => Promise.resolve(true))
  epubIsDirty.mockImplementation(() => false)
  requestEpubClose.mockImplementation(() => Promise.resolve(true))
  shellWindow = makeShellWindow()
  onChanged = vi.fn()
  applyMenuFor = vi.fn()
  manager = new TabManager(
    shellWindow as never,
    () => onChanged(),
    (kind) => applyMenuFor(kind),
  )
})

/** the fake view behind a docs tab */
function viewOf(tabId: string): FakeView {
  const contents = manager.webContentsForTab(tabId) as unknown
  const view = createDocsView.mock.results
    .map((r) => r.value as FakeView)
    .find((v) => v.webContents === contents)
  if (!view) throw new Error(`no view for ${tabId}`)
  return view
}

function translationSplit(): { left: string; right: string } {
  const left = manager.openDocsTab('/p/source/a.docx')
  const right = manager.openDocsTab('/p/output/a.docx')
  manager.setTabReadOnly(left)
  manager.beginSplit(left, right, 'side', 0.5, 'b')
  return { left, right }
}

describe('hiding a pane (setPaneHidden)', () => {
  it('is refused without a split', () => {
    manager.openDocsTab('/a.docx')
    expect(manager.setPaneHidden('left', true)).toBe(false)
  })

  it('is refused for an ordinary split (no read-only pane)', () => {
    const a = manager.openDocsTab('/a.docx')
    const b = manager.openDocsTab('/b.docx')
    manager.beginSplit(a, b, 'side', 0.5, 'b')
    expect(manager.setPaneHidden('left', true)).toBe(false)
    expect(manager.splitState()?.collapsed).toBeNull()
  })

  it('shows both panes again once the read-only pane is replaced', () => {
    const { left } = translationSplit()
    manager.setPaneHidden('right', true)
    expect(manager.splitState()).toMatchObject({ collapsed: 'b', focus: 'a' })
    // another document tab takes over the focused (source) pane
    const other = manager.openDocsTab('/other.docx')
    const state = manager.splitState()
    expect(state?.aTabId).toBe(other)
    expect(state?.aTabId).not.toBe(left)
    expect(state?.collapsed).toBeNull()
  })

  it('hides the left pane: its view turns invisible, the right pane fills the content', () => {
    const { left, right } = translationSplit()
    const leftView = viewOf(left)
    const rightView = viewOf(right)
    leftView.setBounds.mockClear()
    expect(manager.setPaneHidden('left', true)).toBe(true)
    expect(manager.splitState()).toMatchObject({ collapsed: 'a', focus: 'b' })
    expect(leftView.setVisible).toHaveBeenLastCalledWith(false)
    expect(rightView.setVisible).toHaveBeenLastCalledWith(true)
    expect(rightView.setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: TAB_STRIP_HEIGHT,
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT - TAB_STRIP_HEIGHT,
    })
    // the hidden view is never re-sized or closed
    expect(leftView.setBounds).not.toHaveBeenCalled()
    expect(leftView.webContents.close).not.toHaveBeenCalled()
  })

  it('hiding a pane keeps its scroll position after showing again', () => {
    const { left } = translationSplit()
    const leftView = viewOf(left)
    const before = leftView.setBounds.mock.calls.at(-1)?.[0]
    manager.setPaneHidden('left', true)
    manager.setPaneHidden('left', false)
    // same live view (no reload, nothing re-created) at the same rectangle,
    // so the document's own scroll offset is untouched
    expect(manager.webContentsForTab(left)).toBe(leftView.webContents)
    expect(leftView.webContents.reload).not.toHaveBeenCalled()
    expect(createDocsView).toHaveBeenCalledTimes(2)
    expect(leftView.setVisible).toHaveBeenLastCalledWith(true)
    expect(leftView.setBounds.mock.calls.at(-1)?.[0]).toEqual(before)
    expect(manager.splitState()?.collapsed).toBeNull()
  })

  it('never hides both panes: hiding the right one shows the left one', () => {
    const { left, right } = translationSplit()
    manager.setPaneHidden('left', true)
    manager.setPaneHidden('right', true)
    expect(manager.splitState()).toMatchObject({ collapsed: 'b', focus: 'a' })
    expect(viewOf(left).setVisible).toHaveBeenLastCalledWith(true)
    expect(viewOf(right).setVisible).toHaveBeenLastCalledWith(false)
    expect(manager.list().find((t) => t.active)?.id).toBe(left)
  })

  it('activating the hidden pane tab from the strip shows it again', () => {
    const { left } = translationSplit()
    manager.setPaneHidden('left', true)
    manager.activateTab(left)
    expect(manager.splitState()).toMatchObject({ collapsed: null, focus: 'a' })
    expect(viewOf(left).setVisible).toHaveBeenLastCalledWith(true)
  })

  it('reports the hidden pane in the split notice', () => {
    const onSplit = vi.fn()
    manager = new TabManager(
      shellWindow as never,
      () => onChanged(),
      (kind) => applyMenuFor(kind),
      undefined,
      () => 1,
      onSplit,
    )
    translationSplit()
    manager.setPaneHidden('right', true)
    expect(onSplit).toHaveBeenLastCalledWith(expect.objectContaining({ collapsed: 'b' }))
  })
})

describe('read-only tabs (setTabReadOnly)', () => {
  it('marks the tab in the list and guards its view at the shell boundary', () => {
    const id = manager.openDocsTab('/p/source/a.docx')
    const view = viewOf(id)
    expect(manager.setTabReadOnly(id)).toBe(true)
    expect(manager.list().find((t) => t.id === id)).toMatchObject({ readOnly: true })
    expect(manager.isReadOnlyTab(id)).toBe(true)
    expect(manager.isReadOnlyWebContents(view.webContents.id)).toBe(true)
    expect(view.webContents.listeners.has('before-input-event')).toBe(true)
    expect(view.webContents.ipc.handle).toHaveBeenCalledWith('docs:save', expect.any(Function))
    // a second call installs nothing twice
    manager.setTabReadOnly(id)
    expect(view.webContents.ipc.handle.mock.calls.filter(([c]) => c === 'docs:save')).toHaveLength(
      1,
    )
  })

  it('refuses Home', () => {
    expect(manager.setTabReadOnly('home')).toBe(false)
  })

  it('source pane rejects edit commands: typed keys are cancelled, arrows pass', () => {
    const id = manager.openDocsTab('/p/source/a.docx')
    manager.setTabReadOnly(id)
    const onInput = viewOf(id).webContents.listeners.get('before-input-event') as unknown as (
      e: { preventDefault: () => void },
      input: object,
    ) => void
    const prevent = vi.fn()
    const input = { type: 'keyDown', control: false, meta: false, alt: false, shift: false }
    onInput({ preventDefault: prevent }, { ...input, key: 'x' })
    onInput({ preventDefault: prevent }, { ...input, key: 'ArrowDown' })
    expect(prevent).toHaveBeenCalledTimes(1)
  })

  it('stays in the strip: it cannot be detached', () => {
    const id = manager.openDocsTab('/p/source/a.docx')
    manager.setTabReadOnly(id)
    expect(manager.canDetachTab(id)).toBe(false)
    expect(manager.detachTab(id)).toBeNull()
  })

  it('closes without a save prompt even when its editor reports edits', async () => {
    const id = manager.openDocsTab('/p/source/a.docx')
    manager.setTabReadOnly(id)
    docsQueryDirty.mockImplementation(() => Promise.resolve(true))
    await manager.closeTab(id)
    expect(requestDocsClose).not.toHaveBeenCalled()
    expect(manager.list().some((t) => t.id === id)).toBe(false)
  })

  it('is left out of the window-close prompts, the agents list and the session record', async () => {
    const source = manager.openMarkdownTab('/p/source/a.md')
    const output = manager.openMarkdownTab('/p/output/a.md')
    manager.setTabReadOnly(source)
    markdownIsDirty.mockImplementation(() => true)
    expect(manager.dirtyMarkdownTabs().map((t) => t.id)).toEqual([output])
    expect((await manager.openDocuments()).map((t) => t.id)).toEqual([output])
    manager.beginSplit(source, output, 'side', 0.5, 'b')
    const session = manager.sessionTabs()
    expect(session.tabs.map((t) => t.id)).toEqual([output])
    expect(session.split).toBeNull()
    markdownIsDirty.mockImplementation(() => false)
  })
})
