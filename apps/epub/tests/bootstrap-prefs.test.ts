import { afterEach, expect, it, vi } from 'vitest'
import { aiEditUndoHistoryEnabled, applyAiPanelPrefs } from '@genoffice/ui'

const { render } = vi.hoisted(() => ({ render: vi.fn() }))
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render }) }))
vi.mock('../src/renderer/App', () => ({ default: () => null }))

afterEach(() => {
  vi.unstubAllGlobals()
  applyAiPanelPrefs({})
})

it('loads a saved undo opt-out before the EPUB editor can accept an edit', async () => {
  let load!: (prefs: { aiEditUndoHistory: boolean }) => void
  const pending = new Promise<{ aiEditUndoHistory: boolean }>((resolve) => {
    load = resolve
  })
  const getAiPanelPrefs = vi.fn(() => pending)
  vi.stubGlobal('epubApi', {
    getLanguage: async () => 'en',
    getTheme: async () => 'system',
    onThemeChanged: () => {},
    getAiPanelPrefs,
    onAiPanelPrefsChanged: () => {},
  })
  expect(aiEditUndoHistoryEnabled()).toBe(true)
  await import('../src/renderer/main')
  await vi.waitFor(() => expect(getAiPanelPrefs).toHaveBeenCalledOnce())
  expect(render).not.toHaveBeenCalled()
  load({ aiEditUndoHistory: false })
  await vi.waitFor(() => expect(render).toHaveBeenCalledOnce())
  expect(aiEditUndoHistoryEnabled()).toBe(false)
})
