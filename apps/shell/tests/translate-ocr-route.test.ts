import { describe, expect, it } from 'vitest'
import type { AiSettings, AiSubscriptionStatuses } from '@genoffice/ai-provider/browser'
import { ocrProviderId, ocrRoute } from '../src/renderer/src/translate/ocr-route'

/**
 * Which AI the translation OCR sends to: the project's choice (Claude or
 * ChatGPT) mapped onto the app's subscription connections, never a key
 * provider and never a paid path the person did not accept.
 */

const ready = { state: 'ready' } as const
const signedOut = { state: 'signed-out' } as const

function settings(patch: Partial<AiSettings> = {}): AiSettings {
  return {
    provider: 'auto',
    providers: {} as AiSettings['providers'],
    subscriptionNoticeSeen: true,
    subscriptionNoticeVersion: 99,
    ...patch,
  } as AiSettings
}

const all = (s: Partial<Record<string, unknown>>) => s as AiSubscriptionStatuses

describe('ocrProviderId', () => {
  it('claude is the Claude subscription whatever the app-wide choice is', () => {
    expect(ocrProviderId('claude', settings({ provider: 'codex' }), all({}))).toBe('claude-code')
    expect(ocrProviderId('claude', settings({ provider: 'anthropic' }), all({}))).toBe(
      'claude-code',
    )
  })

  it('chatgpt keeps the ChatGPT connection the person chose app-wide', () => {
    expect(ocrProviderId('chatgpt', settings({ provider: 'codex' }), all({ chatgpt: ready }))).toBe(
      'codex',
    )
    expect(ocrProviderId('chatgpt', settings({ provider: 'chatgpt' }), all({ codex: ready }))).toBe(
      'chatgpt',
    )
  })

  it('chatgpt otherwise takes the direct connection, then Codex, when ready', () => {
    expect(ocrProviderId('chatgpt', settings(), all({ chatgpt: ready, codex: ready }))).toBe(
      'chatgpt',
    )
    expect(ocrProviderId('chatgpt', settings(), all({ chatgpt: signedOut, codex: ready }))).toBe(
      'codex',
    )
    expect(ocrProviderId('chatgpt', settings(), all({}))).toBe('chatgpt')
  })
})

describe('ocrRoute', () => {
  it('is checking until the settings and statuses are known', () => {
    expect(ocrRoute('claude', null, all({})).state).toBe('checking')
    expect(ocrRoute('claude', settings(), null).state).toBe('checking')
  })

  it('a ready subscription runs on settings pinned to it, without changing the app-wide choice', () => {
    const stored = settings({ provider: 'codex' })
    const route = ocrRoute('claude', stored, all({ 'claude-code': ready, codex: ready }))
    expect(route).toMatchObject({ state: 'ready', provider: 'claude-code', paid: false })
    if (route.state === 'ready') expect(route.settings.provider).toBe('claude-code')
    expect(stored.provider).toBe('codex')
  })

  it('a provider that is not connected shows the connect prompt and does not run', () => {
    const route = ocrRoute('claude', settings(), all({ 'claude-code': signedOut }))
    expect(route.state).toBe('connect')
  })

  it('a metered login runs only when accepted, and is then shown as paid', () => {
    const metered = { state: 'metered', provider: 'claude-code', meteredAccepted: true }
    expect(ocrRoute('claude', settings(), all({ 'claude-code': metered })).state).toBe('connect')
    const accepted = ocrRoute(
      'claude',
      settings({ meteredAccepted: { 'claude-code': true } }),
      all({ 'claude-code': metered }),
    )
    expect(accepted).toMatchObject({ state: 'ready', paid: true })
  })

  it('an unread first-connection notice holds the start', () => {
    const route = ocrRoute(
      'claude',
      settings({ subscriptionNoticeSeen: false, subscriptionNoticeVersion: 0 }),
      all({ 'claude-code': ready }),
    )
    expect(route.state).toBe('notice')
  })
})
