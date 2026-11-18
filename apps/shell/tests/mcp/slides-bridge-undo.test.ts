/**
 * An MCP slides transaction is an AI edit: it follows the "AI edit undo history"
 * setting (decision 0114).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sessions = new Map<number, unknown>()
const applySessionTxn = vi.fn()

vi.mock('electron', () => ({ webContents: { fromId: () => null } }))
vi.mock('../../../slides/src/main/slides-main', () => ({
  applySessionTxn,
  saveSessionDeckTo: vi.fn(),
}))
vi.mock('../../../slides/src/main/session-state', () => ({
  sessions,
  attachedIds: () => [],
}))

const { createSlidesControl } = await import('../../src/main/mcp/slides-bridge')

const req = { ops: [{ op: 'noop' }] } as never

beforeEach(() => {
  applySessionTxn.mockReset()
  applySessionTxn.mockReturnValue({ applied: false })
  sessions.set(1, { opened: { deck: { size: { cx: 1, cy: 1 } } } })
})

describe('slides MCP transaction undo', () => {
  it('drops the undo step while the setting is off', async () => {
    const control = createSlidesControl({ openBlankTab: () => 1, aiEditUndoHistory: () => false })
    await control.runTxn(1, req)
    expect(applySessionTxn.mock.calls[0]![2]).toEqual({ dropUndo: true })
  })

  it('keeps the undo step while the setting is on', async () => {
    const control = createSlidesControl({ openBlankTab: () => 1, aiEditUndoHistory: () => true })
    await control.runTxn(1, req)
    expect(applySessionTxn.mock.calls[0]![2]).toEqual({ dropUndo: false })
  })

  it('keeps undo when no setting source is wired (old behaviour)', async () => {
    const control = createSlidesControl({ openBlankTab: () => 1 })
    await control.runTxn(1, req)
    expect(applySessionTxn.mock.calls[0]![2]).toEqual({ dropUndo: false })
  })
})
