import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { aiHistoryBatchRequest } from '../src/renderer/history-batch'

describe('aiHistoryBatchRequest', () => {
  it('is the ordinary collapsing batch while AI edit undo history is on', () => {
    expect(aiHistoryBatchRequest(true)).toEqual({ aiRun: true })
    expect(aiHistoryBatchRequest(true, true)).toEqual({ aiRun: true })
  })

  it('asks for a drop batch while it is off', () => {
    expect(aiHistoryBatchRequest(false)).toEqual({ dropUndo: true })
  })

  it('lets the QC pass keep an internal rollback point only', () => {
    expect(aiHistoryBatchRequest(false, true)).toEqual({ dropUndo: true, keepRollback: true })
  })
})

describe('AI panel history wiring', () => {
  const panel = readFileSync(resolve(__dirname, '../src/renderer/ai/AiPanel.tsx'), 'utf8')

  it('opens every AI batch (run, queued page, QC page) through the switch', () => {
    expect(panel.match(/beginHistoryBatch\(/g)).toHaveLength(3)
    expect(panel.match(/aiHistoryBatchRequest\(\s*aiEditUndoHistoryEnabled\(/g)).toHaveLength(3)
  })

  it('releases a late rollback point if the setting was switched off while awaiting the batch', () => {
    const finish = panel.slice(
      panel.indexOf('const finishHistoryBatch ='),
      panel.indexOf('const rollback ='),
    )
    expect(finish).toMatch(
      /if \(!aiEditUndoHistoryEnabled\(\)\) \{\s*await window.slidesApi.aiSnapshotRelease\(id\)\s*return/,
    )
  })

  it('never shows a rollback point the QC pass kept for itself', () => {
    expect(panel).toContain('aiSnapshotRelease(batchId)')
    expect(panel).toContain('recordUndo: false')
  })
})
