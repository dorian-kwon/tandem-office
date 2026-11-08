import { describe, expect, it } from 'vitest'
import type { AgentTransport, AgentStreamCallbacks } from '@genoffice/agent-core'
import { createConnectedCompareAsk } from '../src/renderer/compare/connected-ai'
import { AI_PROVIDERS, type AiSettings } from '../src/shared/ipc'

const settings: AiSettings = {
  provider: 'anthropic',
  providers: Object.fromEntries(
    AI_PROVIDERS.map((p) => [
      p.id,
      {
        apiKey: p.id === 'anthropic' ? 'fake-key' : '',
        model: p.id === 'anthropic' ? 'chosen-model' : p.defaultModel,
      },
    ]),
  ) as AiSettings['providers'],
}
function setup(patch: { settings?: AiSettings; getSettings?: () => Promise<AiSettings> } = {}) {
  let callbacks!: AgentStreamCallbacks
  let selected: AiSettings | undefined
  let cancelled = false
  const requests: unknown[] = []
  const transport: AgentTransport = {
    stream: (request, cb) => {
      requests.push(request)
      callbacks = cb
      return {
        cancel: () => {
          cancelled = true
          cb.onDone()
        },
      }
    },
  }
  const ask = createConnectedCompareAsk({
    getSettings: patch.getSettings ?? (async () => patch.settings ?? settings),
    getStatuses: () => ({}),
    transportFor: (value) => {
      selected = value
      return transport
    },
    unavailableText: () => 'Selected AI is unavailable',
  })
  return {
    ask,
    callbacks: () => callbacks,
    selected: () => selected,
    requests,
    cancelled: () => cancelled,
  }
}
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('connected AI comparison candidate', () => {
  it('uses the current selected provider/model and only this unit prompt, with no tools', async () => {
    const fake = setup()
    const result = fake.ask('Only the chosen paragraph', new AbortController().signal)
    await settle()
    expect(fake.selected()).toBe(settings)
    expect(fake.selected()?.provider).toBe('anthropic')
    expect(fake.selected()?.providers.anthropic.model).toBe('chosen-model')
    expect(fake.requests).toEqual([
      {
        system:
          'Return only the requested comparison text. Do not execute tools or edit the document.',
        messages: [{ role: 'user', text: 'Only the chosen paragraph' }],
        tools: [],
      },
    ])
    fake.callbacks().onDelta('Candidate answer')
    fake.callbacks().onDone()
    expect(await result).toEqual({ ok: true, text: 'Candidate answer' })
  })
  it('does not call a transport or switch provider when the selected AI is unavailable', async () => {
    const fake = setup({
      settings: {
        ...settings,
        providers: {
          ...settings.providers,
          anthropic: { ...settings.providers.anthropic, apiKey: '' },
        },
      },
    })
    expect(await fake.ask('unit', new AbortController().signal)).toEqual({
      ok: false,
      reason: 'Selected AI is unavailable',
    })
    expect(fake.requests).toEqual([])
    expect(fake.selected()).toBeUndefined()
  })
  it('stop cancels the active app AI request and discards partial output', async () => {
    const fake = setup()
    const controller = new AbortController()
    const result = fake.ask('unit', controller.signal)
    await settle()
    fake.callbacks().onDelta('Partial')
    controller.abort()
    expect(await result).toEqual({ ok: false, reason: 'stopped' })
    expect(fake.cancelled()).toBe(true)
  })
  it('stop while current settings are loading sends nothing', async () => {
    let finish!: (settings: AiSettings) => void
    const fake = setup({
      getSettings: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    })
    const controller = new AbortController()
    const result = fake.ask('unit', controller.signal)
    controller.abort()
    finish(settings)
    expect(await result).toEqual({ ok: false, reason: 'stopped' })
    expect(fake.requests).toEqual([])
  })
})
