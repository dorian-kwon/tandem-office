/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest'
import {
  initializeAiPanelPrefs,
  applyAiPanelPrefs,
  aiEditUndoHistoryEnabled,
} from '../src/ai-panel-prefs-store'

afterEach(() => applyAiPanelPrefs({}))

describe('aiEditUndoHistoryEnabled', () => {
  it('is on until the shell says otherwise, including for old settings payloads', () => {
    applyAiPanelPrefs({})
    expect(aiEditUndoHistoryEnabled()).toBe(true)
    applyAiPanelPrefs({ side: 'right' })
    expect(aiEditUndoHistoryEnabled()).toBe(true)
  })

  it('follows the live preference both ways', () => {
    applyAiPanelPrefs({ aiEditUndoHistory: true })
    expect(aiEditUndoHistoryEnabled()).toBe(true)
    applyAiPanelPrefs({ aiEditUndoHistory: false })
    expect(aiEditUndoHistoryEnabled()).toBe(false)
  })
})

describe('initial editor preferences', () => {
  it('applies a saved opt-out before completing startup and follows later changes', async () => {
    let changed!: (prefs: unknown) => void
    await initializeAiPanelPrefs({
      getAiPanelPrefs: async () => ({ aiEditUndoHistory: false }),
      onAiPanelPrefsChanged: (listener) => {
        changed = listener
      },
    })
    expect(aiEditUndoHistoryEnabled()).toBe(false)
    changed({ aiEditUndoHistory: true })
    expect(aiEditUndoHistoryEnabled()).toBe(true)
  })

  it('keeps a newer opt-out that arrived during the initial read', async () => {
    let changed!: (prefs: unknown) => void
    let finish!: (prefs: unknown) => void
    const ready = initializeAiPanelPrefs({
      onAiPanelPrefsChanged: (listener) => {
        changed = listener
      },
      getAiPanelPrefs: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    })
    changed({ aiEditUndoHistory: false })
    finish({})
    await ready
    expect(aiEditUndoHistoryEnabled()).toBe(false)
  })
})
