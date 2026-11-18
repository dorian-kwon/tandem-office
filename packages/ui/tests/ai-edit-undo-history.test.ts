/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest'
import { applyAiPanelPrefs, aiEditUndoHistoryEnabled } from '../src/ai-panel-prefs-store'

afterEach(() => applyAiPanelPrefs({}))

describe('aiEditUndoHistoryEnabled', () => {
  it('is off until the shell says otherwise, including for old settings payloads', () => {
    applyAiPanelPrefs({})
    expect(aiEditUndoHistoryEnabled()).toBe(false)
    applyAiPanelPrefs({ side: 'right' })
    expect(aiEditUndoHistoryEnabled()).toBe(false)
  })

  it('follows the live preference both ways', () => {
    applyAiPanelPrefs({ aiEditUndoHistory: true })
    expect(aiEditUndoHistoryEnabled()).toBe(true)
    applyAiPanelPrefs({ aiEditUndoHistory: false })
    expect(aiEditUndoHistoryEnabled()).toBe(false)
  })
})
