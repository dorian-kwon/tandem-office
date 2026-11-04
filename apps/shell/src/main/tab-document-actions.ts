import type { WebContents } from 'electron'
import type { TabSummary } from '../shared/tabs-api'

export type TabDocumentAction = 'save' | 'saveAs' | 'print'
export type TabDocumentTarget = { id: string; webContents: WebContents; filePath?: string }

export interface TabDocumentActionDeps {
  tabs: {
    list(): TabSummary[]
    activateTab(id: string): void
    canDetachTab(id: string): boolean
    webContentsForTab(id: string): WebContents | undefined
    /** the tab is the translation view's output pane */
    isTranslationOutput?(id: string): boolean
  }
  /**
   * Save as for a translation output: copy its saved file to a place the person picks,
   * leaving the pane on the project's output file (the editor's own Save As would move it).
   */
  translationSaveAs?(outputPath: string): void
  savePdf(contents: WebContents): void
  savePdfAs(target: TabDocumentTarget): void
  printPdf(contents: WebContents): void
  saveMarkdown(contents: WebContents, mode: 'save' | 'saveAs'): void
  printMarkdown(contents: WebContents): void
  saveHtml(contents: WebContents, mode: 'save' | 'saveAs'): void
  printHtml(contents: WebContents): void
}

/** Resolve the clicked tab, then use its editor's existing save and print workflows. */
export function runTabDocumentAction(
  deps: TabDocumentActionDeps,
  id: string,
  action: TabDocumentAction,
): void {
  const tab = deps.tabs.list().find((item) => item.id === id)
  const contents = deps.tabs.webContentsForTab(id)
  if (
    !tab ||
    tab.kind === 'home' ||
    tab.kind === 'help' ||
    !deps.tabs.canDetachTab(id) ||
    !contents ||
    contents.isDestroyed()
  )
    return
  // the translation view's source pane is never saved (Save As included)
  if (tab.readOnly && action !== 'print') return
  if (
    action === 'saveAs' &&
    tab.filePath &&
    deps.translationSaveAs &&
    deps.tabs.isTranslationOutput?.(id)
  ) {
    deps.tabs.activateTab(id)
    deps.translationSaveAs(tab.filePath)
    return
  }
  deps.tabs.activateTab(id)
  const command = action === 'saveAs' ? 'save-as' : action
  switch (tab.kind) {
    case 'docs':
      contents.send('menu:command', command)
      break
    case 'sheets':
      contents.send('menu:action', command)
      break
    case 'slides':
      contents.send('slides:menu', command)
      break
    case 'pdf':
      if (action === 'print') deps.printPdf(contents)
      else if (action === 'saveAs')
        deps.savePdfAs({ id, webContents: contents, filePath: tab.filePath })
      else deps.savePdf(contents)
      break
    case 'markdown':
      if (action === 'print') deps.printMarkdown(contents)
      else deps.saveMarkdown(contents, action)
      break
    case 'html':
      if (action === 'print') deps.printHtml(contents)
      else deps.saveHtml(contents, action)
      break
  }
}
