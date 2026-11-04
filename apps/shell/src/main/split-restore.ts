import type { SplitOrientation } from '../shared/split-view-api'
import { SPLIT_EVEN_RATIO } from './split-layout'
import type { SplitMemory } from './split-memory'

/** What reopening a remembered split needs from the shell (index.ts wires it). */
export interface SplitRestoreDeps {
  /** the path when it is a file on disk, else undefined */
  fileOnDisk(path: string | undefined): string | undefined
  /** same file after resolving links (canonicalPath) */
  samePath(a: string, b: string): boolean
  /** route the file into its editor tab; the landed tab's id */
  openTab(path: string, options: { recordRecent: boolean }): string | undefined
  openHome(): void
  openDuplicatePaneTab(tabId: string): string | null
  setTabReadOnly(tabId: string): boolean
  /** bind the translation pair into one unit that closes together */
  groupTabs(firstId: string, secondId: string): boolean
  beginSplit(
    aTabId: string,
    bTabId: string,
    orientation: SplitOrientation,
    ratio: number,
    focus: 'a' | 'b',
    collapsed: 'a' | 'b' | null,
  ): void
}

/**
 * A launch with no file argument: reopen the remembered arrangement when its
 * documents are still on disk, else the home screen. A remembered path that
 * is gone is skipped: one remaining document opens alone, both gone falls back
 * to home.
 *
 * The translation view's source pane (`memory.readOnly`) comes back read-only
 * and grouped with its output (they close together), it is made read-only
 * before the other document opens, and it never enters Recent. A pane stays
 * hidden only while the source is read-only. A read-only source whose output
 * is gone is not opened at all (a source never outlives its output): the
 * output alone opens as an ordinary document, and a lone source falls back to
 * home.
 */
export function restoreRememberedSplit(memory: SplitMemory | null, deps: SplitRestoreDeps): void {
  const aPath = deps.fileOnDisk(memory?.a)
  const bPath = deps.fileOnDisk(memory?.b)
  if (aPath === undefined && bPath === undefined) {
    deps.openHome()
    return
  }
  const orientation = memory?.orientation ?? 'side'
  const ratio = memory?.ratio ?? SPLIT_EVEN_RATIO
  const focus = memory?.focus ?? 'b'
  const readOnly = memory?.readOnly
  if (readOnly !== undefined && (aPath === undefined || bPath === undefined)) {
    const outputPath = readOnly === 'a' ? bPath : aPath
    // the output opens alone and plain; the orphan source is dropped
    if (outputPath === undefined || deps.openTab(outputPath, { recordRecent: true }) === undefined)
      deps.openHome()
    return
  }
  // both panes held the same file: one tab, duplicated for the second pane
  if (aPath !== undefined && bPath !== undefined && deps.samePath(aPath, bPath)) {
    const aTabId = deps.openTab(aPath, { recordRecent: readOnly === undefined })
    if (aTabId === undefined) {
      deps.openHome()
      return
    }
    const bTabId = deps.openDuplicatePaneTab(aTabId)
    if (bTabId === null) return
    deps.beginSplit(aTabId, bTabId, orientation, ratio, focus, null)
    return
  }
  let readOnlyApplied = false
  const open = (path: string | undefined, pane: 'a' | 'b'): string | undefined => {
    if (path === undefined) return undefined
    const id = deps.openTab(path, { recordRecent: readOnly !== pane })
    if (id !== undefined && readOnly === pane) readOnlyApplied = deps.setTabReadOnly(id)
    return id
  }
  const aTabId = open(aPath, 'a')
  const bTabId = open(bPath, 'b')
  if (aTabId === undefined && bTabId === undefined) {
    deps.openHome()
    return
  }
  if (aTabId !== undefined && bTabId !== undefined) {
    const collapsed = readOnlyApplied ? (memory?.collapsed ?? null) : null
    if (readOnlyApplied) deps.groupTabs(aTabId, bTabId)
    deps.beginSplit(aTabId, bTabId, orientation, ratio, focus, collapsed)
  }
}
