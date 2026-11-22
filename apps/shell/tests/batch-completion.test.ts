import { describe, expect, it, vi } from 'vitest'
import { runBatchTranslation } from '../src/main/translate/batch-completion'

describe('unattended translation completion reports', () => {
  const edited = {
    kind: 'done' as const,
    id: 'turn',
    mutated: true,
    inspected: true,
    incomplete: false,
  }

  it('accepts a verified report without another request', async () => {
    const send = vi.fn(async () => ({
      ...edited,
      text: 'Translated.\nPROJECT_TRANSLATION_COMPLETE',
    }))
    await runBatchTranslation('Translate this document.', send)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('keeps a reported blocker or an interrupted turn out of the confirmation loop', async () => {
    const blocked = vi.fn(async () => ({
      ...edited,
      text: 'Needs input.\nPROJECT_TRANSLATION_INCOMPLETE',
    }))
    await expect(runBatchTranslation('Translate.', blocked)).rejects.toThrow()
    expect(blocked).toHaveBeenCalledTimes(1)
    const truncated = vi.fn(async () => ({ ...edited, text: 'Still working', incomplete: true }))
    expect((await runBatchTranslation('Translate.', truncated)).incomplete).toBe(true)
    expect(truncated).toHaveBeenCalledTimes(1)
  })

  it('requests a missing report only once and rejects an unmarked or negated answer', async () => {
    const send = vi.fn(async () => ({ ...edited, text: 'Not PROJECT_TRANSLATION_COMPLETE' }))
    await expect(runBatchTranslation('Translate.', send)).rejects.toThrow()
    expect(send).toHaveBeenCalledTimes(2)
  })
})
