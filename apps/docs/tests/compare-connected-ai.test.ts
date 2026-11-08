import { describe, expect, it } from 'vitest'
import type { AgentTransport, AgentStreamCallbacks } from '@genoffice/agent-core'
import {
  createConnectedCompareAsk,
  enumerateConnectedComparisons,
  createPinnedConnectedCompareAsk,
} from '../src/renderer/compare/connected-ai'
import type { AiSubscriptionStatuses } from '@genoffice/ai-provider/browser'
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

const ready: AiSubscriptionStatuses = {
  'claude-code': { provider: 'claude-code', state: 'ready', meteredAccepted: false },
  chatgpt: { provider: 'chatgpt', state: 'ready', meteredAccepted: false },
  codex: { provider: 'codex', state: 'ready', meteredAccepted: false },
}
const subscribed: AiSettings = { ...settings, provider: 'auto', subscriptionNoticeSeen: true }

describe('connected comparison enumeration', () => {
  it('includes every ready subscription once and pins the resolved main provider', () => {
    const run = enumerateConnectedComparisons(subscribed, ready)
    expect(run.checking).toBe(false)
    expect(run.candidates.map((c) => c.id)).toEqual([
      'connected-claude-code',
      'connected-chatgpt',
      'connected-codex',
    ])
    expect(run.main?.id).toBe('connected-claude-code')
    expect(run.main?.settings.provider).toBe('claude-code')
  })
  it('never enables saved key providers or accepted metered subscriptions without current selection', () => {
    const run = enumerateConnectedComparisons(
      {
        ...subscribed,
        meteredAccepted: { codex: true },
      },
      {
        ...ready,
        codex: { provider: 'codex', state: 'metered', meteredAccepted: true },
      },
    )
    expect(run.candidates.map((c) => c.id)).toEqual(['connected-claude-code', 'connected-chatgpt'])
  })
  it('includes the explicitly selected key main without enabling other saved keys', () => {
    const run = enumerateConnectedComparisons(
      {
        ...subscribed,
        provider: 'anthropic',
        providers: { ...subscribed.providers, gemini: { apiKey: 'saved-unused', model: 'unused' } },
      },
      ready,
    )
    expect(run.candidates.map((c) => c.id)).toEqual([
      'connected-claude-code',
      'connected-chatgpt',
      'connected-codex',
      'connected-anthropic',
    ])
    expect(run.main?.settings.providers.anthropic.model).toBe('chosen-model')
    expect(run.main?.name).toContain('chosen-model')
  })
  it('permits an explicitly selected accepted metered main, with no duplicate candidate', () => {
    const run = enumerateConnectedComparisons(
      { ...subscribed, provider: 'codex', meteredAccepted: { codex: true } },
      {
        ...ready,
        codex: { provider: 'codex', state: 'metered', meteredAccepted: true },
      },
    )
    expect(run.main?.id).toBe('connected-codex')
    expect(run.candidates.map((c) => c.id)).toEqual([
      'connected-claude-code',
      'connected-chatgpt',
      'connected-codex',
    ])
  })
  it('captures independent settings so later global model and provider edits do not alter the run', () => {
    const input = structuredClone(subscribed)
    const run = enumerateConnectedComparisons(input, ready)
    input.provider = 'anthropic'
    input.providers['claude-code'].model = 'later-model'
    expect(run.main?.settings.provider).toBe('claude-code')
    expect(run.main?.settings.providers['claude-code'].model).toBe('')
    expect(run.candidates[1]?.settings.provider).toBe('chatgpt')
    expect(input.provider).toBe('anthropic')
  })
  it('keeps pending subscription checks visible and never substitutes an unavailable explicit main', () => {
    const run = enumerateConnectedComparisons(
      {
        ...subscribed,
        provider: 'anthropic',
        providers: {
          ...subscribed.providers,
          anthropic: { apiKey: '', model: 'chosen-model' },
        },
      },
      { chatgpt: ready.chatgpt },
    )
    expect(run.checking).toBe(true)
    expect(run.main).toBeUndefined()
    expect(run.candidates.map((c) => c.id)).toEqual(['connected-chatgpt'])
  })
  it('does not upgrade an automatically discovered subscription to a metered login during the run', async () => {
    const run = enumerateConnectedComparisons(
      { ...subscribed, meteredAccepted: { codex: true } },
      ready,
    )
    const candidate = run.candidates.find((c) => c.id === 'connected-codex')!
    const ask = createPinnedConnectedCompareAsk({
      settings: candidate.settings,
      getStatuses: () => ({
        ...ready,
        codex: { provider: 'codex', state: 'metered', meteredAccepted: true },
      }),
      transportFor: () => {
        throw new Error('must not start a paid route')
      },
      unavailableText: () => 'unavailable',
    })
    expect(await ask('unit', new AbortController().signal)).toEqual({
      ok: false,
      reason: 'unavailable',
    })
  })
  it('honors the normal first-connection gate rather than silently sending subscriptions', () => {
    const run = enumerateConnectedComparisons(
      { ...subscribed, subscriptionNoticeSeen: false },
      ready,
    )
    expect(run.candidates).toEqual([])
    expect(run.main).toBeUndefined()
  })
})

describe('pinned connected comparison request', () => {
  it('creates independent transports and preserves pinned models for parallel requests', async () => {
    const chosen: AiSettings[] = []
    const callbacks: AgentStreamCallbacks[] = []
    const input = structuredClone(settings)
    const ask = createPinnedConnectedCompareAsk({
      settings: input,
      getStatuses: () => ready,
      transportFor: (value) => {
        chosen.push(value)
        return {
          stream: (_request, cb) => {
            callbacks.push(cb)
            return { cancel: () => cb.onDone() }
          },
        }
      },
      unavailableText: () => 'unavailable',
    })
    input.provider = 'gemini'
    input.providers.anthropic.model = 'later'
    const a = ask('paragraph one', new AbortController().signal)
    const b = ask('paragraph two', new AbortController().signal)
    expect(chosen).toHaveLength(2)
    expect(chosen.map((c) => [c.provider, c.providers.anthropic.model])).toEqual([
      ['anthropic', 'chosen-model'],
      ['anthropic', 'chosen-model'],
    ])
    callbacks[1]!.onDelta('second')
    callbacks[1]!.onDone()
    callbacks[0]!.onDelta('first')
    callbacks[0]!.onDone()
    expect(await a).toEqual({ ok: true, text: 'first' })
    expect(await b).toEqual({ ok: true, text: 'second' })
  })
  it('resolves automatic settings once and does not fall back after the selected login disconnects', async () => {
    let statuses = ready
    let started = 0
    const ask = createPinnedConnectedCompareAsk({
      settings: subscribed,
      getStatuses: () => statuses,
      transportFor: () => {
        started++
        throw new Error('must not start')
      },
      unavailableText: () => 'unavailable',
    })
    statuses = {
      ...ready,
      'claude-code': { provider: 'claude-code', state: 'signed-out', meteredAccepted: false },
    }
    expect(await ask('unit', new AbortController().signal)).toEqual({
      ok: false,
      reason: 'unavailable',
    })
    expect(started).toBe(0)
  })
  it('stops without a transport and never falls back when a pinned subscription disconnects', async () => {
    let started = 0
    const ask = createPinnedConnectedCompareAsk({
      settings: { ...subscribed, provider: 'claude-code' },
      getStatuses: () => ({
        ...ready,
        'claude-code': { provider: 'claude-code', state: 'signed-out', meteredAccepted: false },
      }),
      transportFor: () => {
        started++
        throw new Error('must not start')
      },
      unavailableText: () => 'unavailable',
    })
    expect(await ask('unit', new AbortController().signal)).toEqual({
      ok: false,
      reason: 'unavailable',
    })
    const stop = new AbortController()
    stop.abort()
    expect(await ask('unit', stop.signal)).toEqual({ ok: false, reason: 'stopped' })
    expect(started).toBe(0)
  })
})
