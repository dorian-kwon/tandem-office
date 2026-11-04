import { beforeEach, expect, it, vi } from 'vitest'
import {
  defaultAiSettings,
  type AiSettings,
  type AiSubscriptionStatuses,
} from '@genoffice/ai-provider'
import { createChatOcrModel } from '../src/main/translate/ocr-chat-model'
const mock = vi.hoisted(() => ({ stream: vi.fn(), refusal: vi.fn() }))
vi.mock('@genoffice/ai-provider', async (original) => ({
  ...(await original<object>()),
  streamForProvider: mock.stream,
}))
vi.mock('@genoffice/electron-utils/ai-run-guard', () => ({ aiRunRefusal: mock.refusal }))
let settings: AiSettings
let statuses: AiSubscriptionStatuses
beforeEach(() => {
  vi.clearAllMocks()
  settings = { ...defaultAiSettings(), provider: 'claude-code', subscriptionNoticeSeen: true }
  statuses = { 'claude-code': { provider: 'claude-code', state: 'ready', meteredAccepted: false } }
  mock.refusal.mockReturnValue(null)
  mock.stream.mockImplementation(async (...args: unknown[]) => {
    ;(args[6] as { onDelta: (text: string) => void }).onDelta('Recognised')
  })
})
const service = () => createChatOcrModel({ settings: () => settings, statuses: () => statuses })
it('uses the pinned subscription and guards each OCR request', async () => {
  const model = service()
  const route = model.route({ kind: 'ai', provider: 'claude' })
  const request = { system: 'OCR', messages: [] }
  expect(await model.ask(route, request, new AbortController().signal, 7)).toBe('Recognised')
  expect(mock.refusal).toHaveBeenCalledWith({
    senderId: 7,
    provider: 'claude-code',
    model: route.model,
  })
  expect(mock.stream.mock.calls[0][4]).toEqual([])
})
it('refuses an unread subscription notice, disconnected route and key provider without sending', async () => {
  settings.subscriptionNoticeSeen = false
  settings.subscriptionNoticeVersion = 0
  expect(() => service().route({ kind: 'ai', provider: 'claude' })).toThrow()
  settings.subscriptionNoticeSeen = true
  statuses = {}
  expect(() => service().route({ kind: 'ai', provider: 'claude' })).toThrow()
  await expect(
    service().ask(
      { provider: 'openai', model: 'gpt-4o', paid: true },
      { system: 'OCR', messages: [] },
      new AbortController().signal,
      7,
    ),
  ).rejects.toThrow()
  expect(mock.stream).not.toHaveBeenCalled()
})
it('refuses changed models and document-policy rejection before streaming', async () => {
  const model = service()
  const route = model.route({ kind: 'ai', provider: 'claude' })
  settings = {
    ...settings,
    providers: {
      ...settings.providers,
      'claude-code': { ...settings.providers['claude-code']!, model: 'changed' },
    },
  }
  await expect(
    model.ask(route, { system: 'OCR', messages: [] }, new AbortController().signal, 7),
  ).rejects.toThrow()
  settings = defaultAiSettings()
  settings.subscriptionNoticeSeen = true
  mock.refusal.mockReturnValue({ reason: 'blocked' })
  const next = model.route({ kind: 'ai', provider: 'claude' })
  await expect(
    model.ask(next, { system: 'OCR', messages: [] }, new AbortController().signal, 7),
  ).rejects.toThrow()
  expect(mock.stream).not.toHaveBeenCalled()
})
