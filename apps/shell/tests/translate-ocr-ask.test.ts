import { describe, expect, it, vi } from 'vitest'
import type { AiSettings, AiStreamChunk, AiStreamRequest } from '@genoffice/ai-provider'
import { createOcrAsk, type OcrStreamBridge } from '../src/renderer/src/translate/ocr-ask'
import type { OcrRoute } from '../src/renderer/src/translate/ocr-route'
import { buildAiReadRequest } from '../../../packages/pdf-structure/src/ai-read/instruction'

/**
 * The OCR call over the shared ai:stream bridge, against a fake bridge: what
 * leaves (no tools, settings pinned to the confirmed provider) and when
 * nothing leaves (the confirmed route no longer holds).
 */

const confirmed: Extract<OcrRoute, { state: 'ready' }> = {
  state: 'ready',
  provider: 'claude-code',
  model: '',
  paid: false,
  settings: { provider: 'claude-code', providers: {} } as unknown as AiSettings,
}

function fakeBridge(answer: (req: AiStreamRequest) => AiStreamChunk[]) {
  let listener: ((chunk: AiStreamChunk) => void) | null = null
  const sent: AiStreamRequest[] = []
  const bridge: OcrStreamBridge = {
    aiStream: vi.fn(async (req: AiStreamRequest) => {
      sent.push(req)
      queueMicrotask(() => {
        for (const chunk of answer(req)) listener?.(chunk)
      })
    }),
    aiStreamCancel: vi.fn(async () => undefined),
    onAiStream: (handler) => {
      listener = handler
      return () => {
        listener = null
      }
    },
  }
  return { bridge, sent }
}

const request = buildAiReadRequest({ image: new Uint8Array([1, 2, 3]) })

describe('createOcrAsk', () => {
  it('sends the page with no tools on settings pinned to the confirmed provider', async () => {
    const { bridge, sent } = fakeBridge((req) => [
      { requestId: req.requestId, type: 'delta', text: 'hel' },
      { requestId: req.requestId, type: 'delta', text: 'lo' },
      { requestId: req.requestId, type: 'done' },
    ])
    const ask = createOcrAsk({
      confirmed,
      ocr: 'claude',
      current: () => confirmed,
      lang: () => 'en',
      bridge,
    })
    await expect(ask('claude', request, new AbortController().signal)).resolves.toBe('hello')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.tools ?? []).toEqual([])
    expect((sent[0]!.settings as AiSettings).provider).toBe('claude-code')
    expect(sent[0]!.messages[0]!.images).toHaveLength(1)
  })

  it('sends nothing when the connection moved to another provider or became paid', async () => {
    const { bridge } = fakeBridge(() => [])
    for (const now of [
      { ...confirmed, provider: 'codex' as const },
      { ...confirmed, paid: true },
    ]) {
      const ask = createOcrAsk({
        confirmed,
        ocr: 'claude',
        current: () => now,
        lang: () => 'en',
        bridge,
      })
      await expect(ask('claude', request, new AbortController().signal)).rejects.toMatchObject({
        kind: 'not-connected',
      })
    }
    expect(bridge.aiStream).not.toHaveBeenCalled()
  })

  it('a used-up limit comes back with its kind, so the run stops', async () => {
    const { bridge } = fakeBridge((req) => [
      { requestId: req.requestId, type: 'error', error: 'limit', errorCode: 'rate-limit' },
    ])
    const ask = createOcrAsk({
      confirmed,
      ocr: 'claude',
      current: () => confirmed,
      lang: () => 'en',
      bridge,
    })
    await expect(ask('claude', request, new AbortController().signal)).rejects.toMatchObject({
      kind: 'rate-limit',
    })
  })
})
