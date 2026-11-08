/**
 * Which editor window is the translation view's output pane. The translation
 * view is a split with a read-only source pane (TabManager.setTabReadOnly), so
 * the output is the other, editable pane of that split. Deriving it from the
 * live split means a restored view and a swapped pane need no extra state.
 * The editors ask through this channel when an AI run begins, to lock the
 * output while the AI translates (packages/ui use-translation-lock.ts).
 */
export const TRANSLATION_OUTPUT_CHANNEL = 'app:is-translation-output'
/** An editor asks for the language pair of the translation project its document belongs to. */
export const TRANSLATION_LANGUAGES_CHANNEL = 'app:get-translation-languages'
/** An editor asks whether it is the translation view's read-only source pane. */
export const TRANSLATION_SOURCE_CHANNEL = 'app:is-translation-source'

export function isTranslationSourceTab(
  tabId: string | undefined,
  split: { aTabId: string; bTabId: string } | null,
  isReadOnly: (tabId: string) => boolean,
): boolean {
  if (tabId === undefined || !split) return false
  if (tabId !== split.aTabId && tabId !== split.bTabId) return false
  return isReadOnly(tabId)
}

export interface SaveAsInterceptorDeps {
  tabIdForWebContents(webContentsId: number): string | undefined
  split(): { aTabId: string; bTabId: string } | null
  isReadOnly(tabId: string): boolean
  filePathOf(tabId: string): string | undefined
  /** run the shell's copy flow for this output file */
  requestCopy(outputPath: string): void
}

/**
 * The shell's answer to an editor's own Save As (any entry: menu, ribbon, shortcut).
 * The output pane runs the shell's copy flow instead of retargeting the editor, the
 * read-only source pane is refused, everything else is the editor's business.
 */
export function translationSaveAsInterceptor(
  deps: SaveAsInterceptorDeps,
): (webContentsId: number) => boolean {
  return (webContentsId) => {
    const tabId = deps.tabIdForWebContents(webContentsId)
    const split = deps.split()
    const isReadOnly = (id: string) => deps.isReadOnly(id)
    if (isTranslationSourceTab(tabId, split, isReadOnly)) return true
    if (tabId === undefined || !isTranslationOutputTab(tabId, split, isReadOnly)) return false
    const path = deps.filePathOf(tabId)
    if (path !== undefined) deps.requestCopy(path)
    return true
  }
}

export function isTranslationOutputTab(
  tabId: string | undefined,
  split: { aTabId: string; bTabId: string } | null,
  isReadOnly: (tabId: string) => boolean,
): boolean {
  if (tabId === undefined || !split) return false
  if (tabId !== split.aTabId && tabId !== split.bTabId) return false
  if (isReadOnly(tabId)) return false
  const other = tabId === split.aTabId ? split.bTabId : split.aTabId
  return isReadOnly(other)
}
