import { afterEach, describe, expect, it } from 'vitest'
import { applyAiPanelPrefs } from '@genoffice/ui'
import { recordEditHistory } from '../src/renderer/edit-ops/history'

afterEach(() => applyAiPanelPrefs({}))
describe('PDF pending-edit history', () => {
  it('preserves human history and clears redo without capturing AI snapshots when off', () => {
    applyAiPanelPrefs({ aiEditUndoHistory: false })
    const undo: string[] = []
    let redo = ['future']
    const commit = (source: 'human' | 'ai') =>
      recordEditHistory(
        source === 'ai',
        () => {
          undo.push(source)
          redo = []
        },
        () => {
          redo = []
        },
      )
    commit('human')
    commit('ai')
    expect(undo).toEqual(['human'])
    expect(redo).toEqual([])
    applyAiPanelPrefs({ aiEditUndoHistory: true })
    commit('ai')
    expect(undo).toEqual(['human', 'ai'])
    applyAiPanelPrefs({ aiEditUndoHistory: false })
    commit('human')
    expect(undo).toEqual(['human', 'ai', 'human'])
  })
})
