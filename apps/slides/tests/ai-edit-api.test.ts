import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyAiPanelPrefs } from '@genoffice/ui'
import { aiEditApi } from '../src/renderer/ai/ai-edit-api'

afterEach(() => {
  applyAiPanelPrefs({})
  vi.unstubAllGlobals()
})
describe('AI edit request source', () => {
  it('routes only AI calls through the source channel and reads preference for each request', async () => {
    const human = vi.fn(async () => null)
    const aiEdit = vi.fn(async () => null)
    vi.stubGlobal('window', { slidesApi: { applyTxn: human, aiEdit } })
    const api = aiEditApi()
    const op = { ops: [] }
    applyAiPanelPrefs({})
    await api.applyTxn(op)
    expect(aiEdit).toHaveBeenLastCalledWith('applyTxn', [op], false)
    applyAiPanelPrefs({ aiEditUndoHistory: true })
    await api.applyTxn(op)
    expect(aiEdit).toHaveBeenLastCalledWith('applyTxn', [op], true)
    await window.slidesApi.applyTxn(op)
    expect(human).toHaveBeenCalledOnce()
    expect(aiEdit).toHaveBeenCalledTimes(2)
  })
})
