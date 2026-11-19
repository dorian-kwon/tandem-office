import type { InMemoryWorkbookAdapter } from '@genoffice/xlsx-gateway/domain/in-memory-workbook'
import type { WorkbookSnapshot } from '@genoffice/xlsx-gateway/domain/workbook.types'

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
