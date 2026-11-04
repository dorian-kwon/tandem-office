/**
 * Which editor window is the translation view's output pane. The translation
 * view is a split with a read-only source pane (TabManager.setTabReadOnly), so
 * the output is the other, editable pane of that split. Deriving it from the
 * live split means a restored view and a swapped pane need no extra state.
 * The editors ask through this channel when an AI run begins, to lock the
 * output while the AI translates (packages/ui use-translation-lock.ts).
 */
export const TRANSLATION_OUTPUT_CHANNEL = 'app:is-translation-output'
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
