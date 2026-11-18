import { describe, expect, it, vi } from 'vitest'
import { withoutAiUndoHistory } from '../studio-plugin/agent-plugin.mjs'

function history() {
  const human = { discard: vi.fn() }
  const redo = { discard: vi.fn() }
  const h = {
    undoStack: [human],
    redoStack: [redo],
    execute(command: ReturnType<typeof command>, wasm: object) {
      const result = command.execute()
      if (command.isNoOp()) command.discard(wasm)
      else h.undoStack.push(command)
      return result
    },
  }
  return { h, human, redo }
}
function command(type = 'snapshot:plugin:ieum-agent:replaceText') {
  return { type, execute: vi.fn(() => 'cursor'), isNoOp: () => false, discard: vi.fn() }
}

describe('HWP AI history adapter', () => {
  it('releases the AI snapshot and redo while preserving earlier human edits and real mutation state', () => {
    const { h, human, redo } = history()
    const ai = command()
    const execute = h.execute
    expect(withoutAiUndoHistory(h, () => h.execute(ai, {}))).toBe('cursor')
    expect(h.undoStack).toEqual([human])
    expect(h.redoStack).toEqual([])
    expect(ai.discard).toHaveBeenCalledOnce()
    expect(redo.discard).toHaveBeenCalledOnce()
    expect(ai.isNoOp()).toBe(false)
    expect(h.execute).toBe(execute)
    const manual = command('snapshot:manual')
    h.execute(manual, {})
    expect(h.undoStack).toEqual([human, manual])
  })

  it('restores the adapter after an atomic transaction failure without touching earlier history', () => {
    const { h, human, redo } = history()
    const ai = command()
    ai.execute.mockImplementation(() => {
      throw new Error('rolled back')
    })
    const execute = h.execute
    expect(() => withoutAiUndoHistory(h, () => h.execute(ai, {}))).toThrow('rolled back')
    expect(h.execute).toBe(execute)
    expect(ai.isNoOp()).toBe(false)
    expect(h.undoStack).toEqual([human])
    expect(h.redoStack).toEqual([redo])
  })
})
