import { describe, expect, it, vi } from 'vitest'
import { COMPARE_CHANNELS, type CompareDriver } from '../src/shared/compare'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({
  app: { once: vi.fn(), getPath: () => '/unused-compare-test' },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
  },
}))
vi.mock('@genoffice/ai-provider/subscription', () => ({ killProcessTree: vi.fn() }))
import { registerCompareIpc } from '../src/main/compare/compare-ipc'

describe('web comparison IPC boundary', () => {
  it('rejects connected and retired engines before invoking the browser driver', async () => {
    const ask = vi.fn<CompareDriver['ask']>(async () => ({ ok: true as const, text: 'Candidate' }))
    registerCompareIpc({
      openPathOf: () => undefined,
      driver: { detect: async () => ({ installed: false }), ask },
    })
    const sender = { id: 4, once: vi.fn(), removeListener: vi.fn() }
    const handler = handlers.get(COMPARE_CHANNELS.ask)!
    for (const siteId of ['connected-ai', 'chatgpt', 'grok']) {
      expect(
        await handler({ sender }, { id: siteId, siteId, prompt: 'A neutral fixture' }),
      ).toEqual({ ok: false, reason: 'invalid request' })
    }
    expect(ask).not.toHaveBeenCalled()
    expect(
      await handler({ sender }, { id: 'web', siteId: 'copilot', prompt: 'A neutral fixture' }),
    ).toEqual({ ok: true, text: 'Candidate' })
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0]?.[0]).toMatchObject({ id: 'copilot' })
  })
})
