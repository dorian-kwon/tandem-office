import type { HistoryBatchRequest } from '../shared/ipc'

/**
 * The history batch an AI run opens. While the "AI edit undo history" switch is off the run
 * leaves no undo step and no rollback point.
 * `internalRollback` (QC pass) still gets a rollback point for its own use, never an undo step.
 * Pass `aiEditUndoHistoryEnabled()` read at the moment the run starts.
 */
export function aiHistoryBatchRequest(
  historyEnabled: boolean,
  internalRollback = false,
): HistoryBatchRequest {
  if (historyEnabled) return { aiRun: true }
  return internalRollback ? { dropUndo: true, keepRollback: true } : { dropUndo: true }
}

/**
 * Run fn as one history batch: every edit inside collapses into a single undo
 * step, so a gesture that spans several IPC calls costs one ⌘Z.
 */
export async function batched<T>(fn: () => Promise<T>): Promise<T> {
  const opened = await window.slidesApi.beginHistoryBatch()
  try {
    return await fn()
  } finally {
    if (opened) await window.slidesApi.endHistoryBatch()
  }
}
