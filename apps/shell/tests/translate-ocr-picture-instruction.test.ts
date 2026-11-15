import { describe, expect, it } from 'vitest'
import {
  AI_READ_CLOSE_TAG,
  AI_READ_EMPTY_PAGE,
  AI_READ_OPEN_TAG,
  buildAiReadRequest,
} from '../../../packages/pdf-structure/src/ai-read/instruction'
import { parseAiPageResponse } from '../../../packages/pdf-structure/src/ai-read/parse'
import { PICTURE_OCR_INSTRUCTION, asPictureRequest } from '../src/shared/ocr-picture-instruction'
import { ocrPayloadPlainText } from '../src/shared/ocr-popup'
import { buildOcrBoxRequest, parseOcrBoxResponse } from '../src/shared/ocr-boxes'
import { createOcrAsk, type OcrStreamBridge } from '../src/renderer/src/translate/ocr-ask'
import type { AiSettings, AiStreamChunk, AiStreamRequest } from '@genoffice/ai-provider'
import type { OcrRoute } from '../src/renderer/src/translate/ocr-route'

describe('picture instruction', () => {
  it('asks for text inside drawings and never tells the model to skip it', () => {
    expect(PICTURE_OCR_INSTRUCTION).toMatch(/speech bubbles/)
    expect(PICTURE_OCR_INSTRUCTION).not.toMatch(/Do not describe the figure or transcribe text/)
    expect(PICTURE_OCR_INSTRUCTION).toContain(AI_READ_OPEN_TAG)
    expect(PICTURE_OCR_INSTRUCTION).toContain(AI_READ_CLOSE_TAG)
    expect(PICTURE_OCR_INSTRUCTION).toContain(AI_READ_EMPTY_PAGE)
  })

  it('keeps the image and swaps only the system prompt', () => {
    const base = buildAiReadRequest({ image: new Uint8Array([1, 2, 3]), mime: 'image/jpeg' })
    const swapped = asPictureRequest(base)
    expect(swapped.system).toBe(PICTURE_OCR_INSTRUCTION)
    expect(swapped.messages).toBe(base.messages)
    expect(swapped.messages[0]!.images?.[0]?.mime).toBe('image/jpeg')
    expect(swapped.tools).toEqual([])
  })

  it('an answer in the same format with bubble text parses to non-empty plain text', () => {
    const answer = `${AI_READ_OPEN_TAG}\n리루, 네 침대 밑에 이런 게 있던데….\n\n침대 밑이요?\n${AI_READ_CLOSE_TAG}`
    const parsed = parseAiPageResponse(answer, { page: 1, pageFingerprint: '' })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      const text = ocrPayloadPlainText(parsed.reading.payload)
      expect(text).toContain('침대 밑에')
      expect(text).toContain('침대 밑이요?')
    }
  })

  it('a figure-only answer has no text (what the page instruction produced for art)', () => {
    const parsed = parseAiPageResponse(`${AI_READ_OPEN_TAG}\n[FIGURE]\n${AI_READ_CLOSE_TAG}`, {
      page: 1,
      pageFingerprint: '',
    })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(ocrPayloadPlainText(parsed.reading.payload).trim()).toBe('')
  })
})

describe('createOcrAsk picture mode', () => {
  const confirmed: Extract<OcrRoute, { state: 'ready' }> = {
    state: 'ready',
    provider: 'claude-code',
    model: '',
    paid: false,
    settings: { provider: 'claude-code', providers: {} } as unknown as AiSettings,
  }
  it('sends the picture instruction with the image when asked for pictures', async () => {
    let listener: ((c: AiStreamChunk) => void) | null = null
    const sent: AiStreamRequest[] = []
    const bridge: OcrStreamBridge = {
      aiStream: async (req) => {
        sent.push(req)
        queueMicrotask(() => {
          listener?.({ requestId: req.requestId, type: 'delta', text: 'x' })
          listener?.({ requestId: req.requestId, type: 'done' })
        })
      },
      aiStreamCancel: async () => undefined,
      onAiStream: (h) => {
        listener = h
        return () => (listener = null)
      },
    }
    const ask = createOcrAsk({
      confirmed,
      ocr: 'claude',
      current: () => confirmed,
      lang: () => 'en',
      bridge,
      pictures: true,
    })
    await ask(
      'claude',
      buildAiReadRequest({ image: new Uint8Array([1, 2, 3]), mime: 'image/jpeg' }),
      new AbortController().signal,
    )
    expect(sent[0]!.system).toBe(PICTURE_OCR_INSTRUCTION)
    expect(sent[0]!.messages[0]!.images).toHaveLength(1)
    expect(sent[0]!.tools ?? []).toEqual([])
  })

  it('keeps the box request as it is: its own instruction asks for places, which a page answer lacks', async () => {
    let listener: ((c: AiStreamChunk) => void) | null = null
    const sent: AiStreamRequest[] = []
    const bridge: OcrStreamBridge = {
      aiStream: async (req) => {
        sent.push(req)
        queueMicrotask(() => {
          listener?.({ requestId: req.requestId, type: 'delta', text: 'x' })
          listener?.({ requestId: req.requestId, type: 'done' })
        })
      },
      aiStreamCancel: async () => undefined,
      onAiStream: (h) => {
        listener = h
        return () => (listener = null)
      },
    }
    const ask = createOcrAsk({
      confirmed,
      ocr: 'claude',
      current: () => confirmed,
      lang: () => 'en',
      bridge,
      pictures: true,
    })
    const boxes = buildOcrBoxRequest({ image: new Uint8Array([1, 2, 3]), mime: 'image/png' })
    await ask('claude', boxes, new AbortController().signal)
    expect(sent[0]!.system).toBe(boxes.system)
    expect(sent[0]!.system).not.toBe(PICTURE_OCR_INSTRUCTION)
  })
})

describe('asPictureRequest', () => {
  it('leaves a box request alone, so the model is still told to answer with places', () => {
    const boxes = buildOcrBoxRequest({ image: new Uint8Array([1]), mime: 'image/png' })
    expect(asPictureRequest(boxes)).toBe(boxes)
  })

  it('the answer the page instruction asks for is not a box answer', () => {
    const answer = `${AI_READ_OPEN_TAG}\nSome text\n${AI_READ_CLOSE_TAG}`
    expect(parseOcrBoxResponse(answer).ok).toBe(false)
  })
})
