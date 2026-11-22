import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { expect, it, vi } from 'vitest'
import type { AiSettings, AiStreamChunk, AiStreamRequest } from '@genoffice/ai-provider'
import type { SubscriptionStatusMap } from '@genoffice/ai-provider/browser'
import { createBatchModelTransport } from '../src/main/translate/batch-model-transport'
import { installBatchModelRelay } from '../src/renderer/src/translate/batch-model-relay'
import {
  BATCH_MODEL_EVENT,
  BATCH_MODEL_REQUEST,
  type BatchModelCommand,
  type BatchModelEvent,
} from '../src/shared/batch-model-relay'

const request = {
  system: 'Project',
  messages: [{ role: 'user' as const, text: '  이 파일만  ' }],
  tools: [],
  runId: 'one',
}
function harness() {
  const ipc = new EventEmitter()
  const events = new EventEmitter()
  const frame = {}
  let command: ((req: BatchModelCommand) => void) | undefined
  let last: BatchModelCommand | undefined
  const wc = Object.assign(events, {
    mainFrame: frame,
    ipc,
    isDestroyed: () => false,
    send(channel: string, req: BatchModelCommand) {
      expect(channel).toBe(BATCH_MODEL_REQUEST)
      last = req
      command?.(req)
    },
  })
  const report = (event: BatchModelEvent) =>
    ipc.emit(BATCH_MODEL_EVENT, { senderFrame: frame }, event)
  const chunks = new Set<(chunk: AiStreamChunk) => void>()
  const stream = vi.fn(async (_req: AiStreamRequest) => {})
  const settings = vi.fn(
    async () =>
      ({
        provider: 'auto',
        providers: {},
        subscriptionNoticeSeen: true,
        subscriptionNoticeVersion: 99,
      }) as AiSettings,
  )
  const statuses = vi.fn(
    async () =>
      ({
        'claude-code': { state: 'ready' },
        codex: { state: 'signed-out' },
        chatgpt: { state: 'signed-out' },
      }) as SubscriptionStatusMap,
  )
  const emit = (chunk: AiStreamChunk) => {
    for (const f of chunks) f(chunk)
  }
  const cancel = vi.fn(async (requestId: string) => {
    emit({ requestId, type: 'done' })
  })
  const controller = new AbortController()
  const confirm = vi.fn(() => false)
  installBatchModelRelay(
    {
      onCommand(fn) {
        command = fn
        return () => {
          command = undefined
        }
      },
      report,
    },
    {
      aiGetSettings: settings,
      aiStream: stream,
      aiStreamCancel: cancel,
      onAiStream(fn) {
        chunks.add(fn)
        return () => {
          chunks.delete(fn)
        }
      },
      getLanguage: async () => 'en',
    },
    { statuses },
    confirm,
  )
  const cb = { onDelta: vi.fn(), onDone: vi.fn(), onToolCall: vi.fn(), onError: vi.fn() }
  const transport = createBatchModelTransport(wc as unknown as WebContents, controller.signal)
  return {
    transport,
    settings,
    statuses,
    stream,
    last: () => last!,
    ipc,
    wc,
    cb,
    cancel,
    confirm,
    emit,
    controller,
  }
}
it('uses the standard AI stream, binds replies to the frame/turn and releases the session', async () => {
  const h = harness()
  h.transport.stream(request, h.cb)
  await vi.waitFor(() => expect(h.stream).toHaveBeenCalledTimes(1))
  const command = h.last()
  if (command.kind !== 'start') throw Error('expected start')
  h.ipc.emit(BATCH_MODEL_EVENT, { senderFrame: {} }, { ...command, kind: 'delta', text: 'forged' })
  h.ipc.emit(
    BATCH_MODEL_EVENT,
    { senderFrame: h.wc.mainFrame },
    { ...command, turn: 'other', kind: 'delta', text: 'stale' },
  )
  expect(h.cb.onDelta).not.toHaveBeenCalled()
  const first = h.stream.mock.calls[0]![0]
  expect(first.settings.provider).toBe('claude-code')
  expect(first.messages).toEqual(request.messages)
  h.emit({ requestId: first.requestId, type: 'delta', text: 'received' })
  h.emit({ requestId: first.requestId, type: 'done' })
  expect(h.cb.onDelta).toHaveBeenCalledWith('received')
  expect(h.cb.onDone).toHaveBeenCalledOnce()
  h.transport.stream(request, h.cb)
  await vi.waitFor(() => expect(h.stream).toHaveBeenCalledTimes(2))
  expect(h.stream.mock.calls[1]![0].sessionId).toBe(first.sessionId)
  expect(h.statuses).toHaveBeenCalledTimes(2)
  h.controller.abort()
  expect(h.cancel).toHaveBeenCalledWith(h.stream.mock.calls[1]![0].requestId, 'request')
  expect(h.cb.onDone).toHaveBeenCalledTimes(2)
  expect(h.ipc.listenerCount(BATCH_MODEL_EVENT)).toBe(0)
})
it('refuses revoked connection and never starts a request interrupted while reading settings', async () => {
  const h = harness()
  h.settings.mockResolvedValueOnce({
    provider: 'auto',
    providers: {},
    subscriptionNoticeSeen: false,
  } as AiSettings)
  h.transport.stream(request, h.cb)
  await vi.waitFor(() => expect(h.cb.onError).toHaveBeenCalledOnce())
  expect(h.stream).not.toHaveBeenCalled()
  let release!: (s: AiSettings) => void
  h.settings.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  const handle = h.transport.stream(request, h.cb)
  handle.cancel()
  release({} as AiSettings)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(h.stream).not.toHaveBeenCalled()
  expect(h.cb.onDone).toHaveBeenCalledOnce()
  h.transport.dispose()
})
it('fails promptly when its window navigates and ignores later messages', async () => {
  const h = harness()
  h.transport.stream(request, h.cb)
  const command = h.last()
  h.wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
  expect(h.cb.onError).not.toHaveBeenCalled()
  h.wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  expect(h.cb.onError).toHaveBeenCalledOnce()
  h.ipc.emit(BATCH_MODEL_EVENT, { senderFrame: h.wc.mainFrame }, { ...command, kind: 'done' })
  expect(h.cb.onDone).not.toHaveBeenCalled()
})

it('uses the local model context confirmation before sending and remembers approval across tool rounds', async () => {
  const h = harness()
  const endpoint = {
    id: 'local',
    name: 'local',
    kind: 'local' as const,
    baseUrl: 'http://localhost:1234/v1',
    apiKey: '',
    model: 'mini',
    modelProfiles: { mini: { contextLength: 1024, tools: true } },
  }
  h.settings.mockResolvedValue({
    provider: 'custom',
    customEndpoint: 'local',
    customEndpoints: [endpoint],
    providers: { custom: { baseUrl: endpoint.baseUrl, apiKey: 'local', model: 'mini' } },
  } as AiSettings)
  const large = { ...request, system: 'text '.repeat(8000) }
  h.transport.stream(large, h.cb)
  await vi.waitFor(() => expect(h.cb.onError).toHaveBeenCalledOnce())
  expect(h.confirm).toHaveBeenCalledTimes(1)
  expect(h.stream).not.toHaveBeenCalled()
  h.confirm.mockReturnValue(true)
  h.transport.stream(large, h.cb)
  await vi.waitFor(() => expect(h.stream).toHaveBeenCalledOnce())
  h.emit({ requestId: h.stream.mock.calls[0]![0].requestId, type: 'done' })
  h.transport.stream(large, h.cb)
  await vi.waitFor(() => expect(h.stream).toHaveBeenCalledTimes(2))
  expect(h.confirm).toHaveBeenCalledTimes(2)
  h.transport.dispose()
})
