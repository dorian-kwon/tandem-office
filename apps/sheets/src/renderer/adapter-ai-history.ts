import type { InMemoryWorkbookAdapter } from '@genoffice/xlsx-gateway/domain/in-memory-workbook'
import type { WorkbookSnapshot, CellChange } from '@genoffice/xlsx-gateway/domain/workbook.types'

/** The live grid owns undo order. Consume the adapter's snapshots for this
 * synchronous commit (including default-sheet pruning) as one grid action. */
export function withAdapterAiHistory<T>(
  adapter: InMemoryWorkbookAdapter,
  commit: () => T,
  record: boolean,
) {
  const history: unknown = Reflect.get(adapter, 'history')
  if (!Array.isArray(history)) throw new Error('the workbook AI history adapter is unavailable')
  const start = history.length
  try {
    const result = commit()
    return { result, before: record ? (history[start] as WorkbookSnapshot | undefined) : undefined }
  } finally {
    history.splice(start)
  }
}

/** Snapshot jumps retain the adapter's committed transaction ids and advance
 * its revision so previews prepared before undo/redo still fail their CAS. */
export function restoreAdapterSnapshot(
  adapter: InMemoryWorkbookAdapter,
  snapshot: WorkbookSnapshot,
): number {
  const revision = (Reflect.get(adapter, 'snapshot') as WorkbookSnapshot).revision + 1
  Reflect.set(adapter, 'snapshot', { ...structuredClone(snapshot), revision })
  return revision
}

/** The demo rollback closures retain both complete adapter snapshots even
 * for a one-cell edit. Count stored values and styles (not empty grid area). */
export function adapterHistoryCells(
  before: WorkbookSnapshot,
  after: WorkbookSnapshot,
  cap: number,
): number {
  let count = 0
  for (const snapshot of [before, after]) {
    for (const sheet of snapshot.sheets) {
      for (const map of [sheet.cells, sheet.styles]) {
        for (const _address in map) {
          if (++count > cap) return count
        }
      }
    }
  }
  return count
}

/** The demo adapter and Univer share one cell undo. Only the affected cell is
 * rewritten, preserving later changes elsewhere and advancing the plan revision. */
export function restoreAdapterCell(
  adapter: InMemoryWorkbookAdapter,
  change: CellChange,
  side: 'before' | 'after',
): number {
  const snapshot = Reflect.get(adapter, 'snapshot') as WorkbookSnapshot
  const revision = snapshot.revision + 1
  const sheets = snapshot.sheets.map((sheet) =>
    sheet.id === change.sheetId
      ? { ...sheet, cells: { ...sheet.cells, [change.address]: change[side] } }
      : sheet,
  )
  Reflect.set(adapter, 'snapshot', { revision, sheets })
  return revision
}
