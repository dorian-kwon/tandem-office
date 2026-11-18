import type { InMemoryWorkbookAdapter } from '@genoffice/xlsx-gateway/domain/in-memory-workbook'
import { aiEditUndoHistoryEnabled } from '@genoffice/ui'

/** The demo adapter has no public no-history apply. Keep its earlier entries and
 * discard only snapshots appended by this synchronous AI commit, without changing the engine. */
export function withAdapterAiHistory<T>(adapter: InMemoryWorkbookAdapter, commit: () => T): T {
  if (aiEditUndoHistoryEnabled()) return commit()
  const history: unknown = Reflect.get(adapter, 'history')
  if (!Array.isArray(history)) throw new Error('the workbook AI history adapter is unavailable')
  const start = history.length
  try {
    return commit()
  } finally {
    history.splice(start)
  }
}
