/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest'
import { applyAiPanelPrefs } from '@genoffice/ui'
import { InMemoryWorkbookAdapter } from '@genoffice/xlsx-gateway/domain/in-memory-workbook'
import { withAdapterAiHistory } from '../src/renderer/adapter-ai-history'

afterEach(() => applyAiPanelPrefs({}))
describe('blank workbook AI history adapter', () => {
  it('drops only the AI revision, preserves prior edits, and honors opt-in', () => {
    const adapter = new InMemoryWorkbookAdapter({
      revision: 0,
      sheets: [{ id: 's', name: 'Sheet1', cells: {} }],
    })
    let id = 0
    const apply = (value: string) =>
      adapter.apply(
        adapter.plan({
          dslVersion: 1,
          summary: 'test edit',
          transactionId: `t${++id}`,
          baseRevision: adapter.getSnapshot().revision,
          operations: [{ op: 'set_cell', sheetId: 's', address: 'A1', value }],
        }),
      )
    applyAiPanelPrefs({})
    apply('human')
    withAdapterAiHistory(adapter, () => apply('AI'))
    expect(adapter.getSnapshot().sheets[0]!.cells.A1?.value).toBe('AI')
    expect(adapter.canUndo).toBe(true)
    adapter.undo()
    expect(adapter.canUndo).toBe(false)
    applyAiPanelPrefs({ aiEditUndoHistory: true })
    withAdapterAiHistory(adapter, () => apply('recorded AI'))
    expect(adapter.canUndo).toBe(true)
  })
})
