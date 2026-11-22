import { parseAiPageResponse } from '../../../packages/pdf-structure/src/ai-read/parse'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createOcrChatService, type OcrChatPopup } from '../src/main/translate/ocr-chat'
import { OCR_BOX_INSTRUCTION } from '../src/shared/ocr-boxes'
import { PICTURE_OCR_INSTRUCTION } from '../src/shared/ocr-picture-instruction'
import { checkOcrPopupResult } from '../src/shared/ocr-popup'

/**
 * A Word document's pictures read in the chat: a picture that can take boxes is read as boxes (the
 * places of its text and their size), and the placement the chat proposes first is the text boxes
 * over the picture, as in the translation project. Other pictures are read as plain text.
 */

let api: Record<string, ReturnType<typeof vi.fn>>
let ask: ReturnType<typeof vi.fn>
let popupAsk: ReturnType<typeof vi.fn>
let service: ReturnType<typeof createOcrChatService>

const context = { docPath: '/p/source/book.docx', projectRoot: '/p' }
const BOX = { x: 0.1, y: 0.2, w: 0.3, h: 0.1, fontHeight: 0.08, text: 'Shop name' }

beforeEach(() => {
  api = {
    prepare: vi.fn(async () => ({
      token: 'lease',
      kind: 'embedded',
      format: 'docx',
      tables: [],
      items: [
        { index: 1, name: 'a.png', location: 'document.xml · ¶2', boxable: true },
        { index: 2, name: 'b.png', location: 'document.xml · ¶9' },
      ],
      ocr: { kind: 'ai', provider: 'claude' },
    })),
    start: vi.fn(async () => {}),
    pageImage: vi.fn(async () => ({ data: new Uint8Array([1]), mime: 'image/png' })),
    preview: vi.fn(async () => null),
    recommend: vi.fn(async () => ({
      placement: { kind: 'docx-after-images' },
      reason: 'after-images',
    })),
    write: vi.fn(async () => ({ outputPath: '/p/output/book (OCR).docx' })),
    release: vi.fn(async () => {}),
    forgetOwner: vi.fn(),
  }
  ask = vi.fn(async (_route: unknown, request: { system: string }) =>
    request.system === OCR_BOX_INSTRUCTION
      ? '<boxes>[{"x":100,"y":200,"w":300,"h":100,"font":80,"text":"Shop name"}]</boxes>'
      : '<page-content>\nPlain text\n</page-content>',
  )
  popupAsk = vi.fn()
  service = createOcrChatService({
    ocr: api as never,
    resolve: async () => ({ dir: '/p', file: 'book.docx' }),
    route: () => ({ provider: 'claude-code', model: 'test', paid: false }),
    ask,
    popup: { ask: popupAsk as unknown as OcrChatPopup['ask'] },
    now: Date.now,
    newToken: () => 'session',
  })
})

async function call(action: string, turnId: string, extra: object = {}) {
  return service.execute(1, { action, turnId, requestId: action + turnId, ...extra }, context)
}
const parsed = (answer: { output: string }) => JSON.parse(answer.output)
async function inspected() {
  return parsed(await call('inspect', 't1')).session as string
}

describe('reading a Word document picture that can take boxes', () => {
  it('asks a boxable picture for the places of its text and any other as a plain page', async () => {
    const session = await inspected()
    const answer = await call('read', 't2', { session, pages: [1, 2] })
    expect(answer.isError).not.toBe(true)
    const systems = ask.mock.calls.map((c) => (c[1] as { system: string }).system)
    expect(systems).toEqual([OCR_BOX_INSTRUCTION, PICTURE_OCR_INSTRUCTION])
    const results = parsed(answer).results
    expect(results[0].text).toBe('Shop name')
    expect(results[1].text).toBe('Plain text')
  })

  it('proposes the text boxes over the picture first, and keeps the list placement as another way', async () => {
    const session = await inspected()
    await call('read', 't2', { session, pages: [1, 2] })
    const proposal = parsed(await call('propose', 't2', { session }))
    expect(proposal.placement).toEqual({
      kind: 'docx-image-boxes',
      images: [{ index: 1, boxes: [BOX] }],
    })
    expect(proposal.reason).toBe('on-picture')
    expect(proposal.alternatives).toEqual([
      { kind: 'docx-after-images' },
      { kind: 'docx-before-images' },
      { kind: 'docx-next-page' },
      { kind: 'docx-end' },
    ])
  })

  it('writes the boxes: the reading keeps its places and the placement names them', async () => {
    const session = await inspected()
    await call('read', 't2', { session, pages: [1, 2] })
    await call('propose', 't2', { session })
    await call('apply', 't3', { session })
    const [token, pages, placement] = api.write.mock.calls[0]!
    expect(token).toBe('lease')
    expect(pages[0].payload).toMatchObject({ kind: 'boxes', boxes: [BOX], text: 'Shop name' })
    expect(placement.kind).toBe('docx-image-boxes')
  })

  it('falls back to the list placement once the text was revised, since the places no longer fit', async () => {
    const session = await inspected()
    await call('read', 't2', { session, pages: [1] })
    const proposal = parsed(
      await call('propose', 't2', { session, texts: [{ index: 1, text: 'Translated' }] }),
    )
    expect(proposal.placement).toEqual({ kind: 'docx-after-images' })
    expect(proposal.texts[0].text).toBe('Translated')
  })

  it('uses the placement the person asked for instead', async () => {
    const session = await inspected()
    await call('read', 't2', { session, pages: [1] })
    const proposal = parsed(
      await call('propose', 't2', { session, placement: { kind: 'docx-end' } }),
    )
    expect(proposal.placement).toEqual({ kind: 'docx-end' })
    expect(proposal.reason).toBe('user-requested')
  })

  it('offers or accepts next-page only for a selection entirely in the document body', async () => {
    const prepared = await api.prepare()
    prepared.items[1].location = 'header1.xml · ¶2'
    api.prepare.mockResolvedValue(prepared)
    const session = await inspected()
    await call('read', 't2', { session, pages: [1, 2] })
    const proposal = parsed(await call('propose', 't2', { session }))
    expect(proposal.alternatives).not.toContainEqual({ kind: 'docx-next-page' })
    const explicit = await call('propose', 't2', { session, placement: { kind: 'docx-next-page' } })
    expect(explicit.isError).toBe(true)
    expect(parsed(explicit).error).toContain('document body')
  })

  it('offers no boxes when no picture gave any', async () => {
    ask.mockResolvedValue('<boxes>[]</boxes>')
    const session = await inspected()
    await call('read', 't2', { session, pages: [1] })
    const proposal = parsed(await call('propose', 't2', { session }))
    expect(proposal.placement).toEqual({ kind: 'docx-after-images' })
  })
})

describe('applying the way the person chose', () => {
  async function proposed() {
    const session = await inspected()
    await call('read', 't2', { session, pages: [1, 2] })
    await call('propose', 't2', { session })
    return session
  }

  it('writes the proposed placement when none is named', async () => {
    const session = await proposed()
    await call('apply', 't3', { session })
    expect(api.write.mock.calls[0]![2].kind).toBe('docx-image-boxes')
  })

  it('writes the other way the person chose, when it is one that was offered', async () => {
    const session = await proposed()
    const applied = await call('apply', 't3', { session, placement: { kind: 'docx-end' } })
    expect(applied.isError).not.toBe(true)
    expect(api.write.mock.calls[0]![2]).toEqual({ kind: 'docx-end' })
  })

  it('writes the proposed placement again when it is named as it was', async () => {
    const session = await proposed()
    await call('apply', 't3', {
      session,
      placement: { kind: 'docx-image-boxes', images: [{ index: 1, boxes: [BOX] }] },
    })
    expect(api.write.mock.calls[0]![2].kind).toBe('docx-image-boxes')
  })

  it('refuses a placement that was never proposed, and writes nothing', async () => {
    const session = await proposed()
    const answer = await call('apply', 't3', {
      session,
      placement: { kind: 'docx-table-cell', table: 1, row: 1, column: 1, overwrite: true },
    })
    expect(answer.isError).toBe(true)
    expect(parsed(answer).error).toMatch(/propose/i)
    expect(api.write).not.toHaveBeenCalled()
  })
})

describe('boxes from the popup', () => {
  it.each(['docx-replace-images', 'docx-after-images', 'docx-before-images', 'docx-next-page'])(
    'uses the prior %s choice, preserves other placements and awaits a separate confirmation',
    async (kind) => {
      popupAsk.mockResolvedValue({
        kind: 'result',
        result: {
          picturePlacement: kind,
          pages: [{ index: 1, location: 'document.xml · ¶2', text: 'Town', boxes: [BOX] }],
        },
      })
      const session = await inspected()
      await call('choose', 't1', { session })
      const proposal = parsed(await call('propose', 't2', { session }))
      expect(proposal.placement).toEqual({ kind })
      expect(proposal.reason).toBe('user-requested')
      expect(proposal.alternatives).toContainEqual({
        kind: 'docx-image-boxes',
        images: [{ index: 1, boxes: [BOX] }],
      })
      expect(api.write).not.toHaveBeenCalled()
      await call('apply', 't3', { session })
      expect(api.write.mock.calls[0]![2]).toEqual({ kind })
    },
  )

  it('applies the exact location approved by Start on the same turn without offering another destination', async () => {
    const chosen = { kind: 'docx-table-cell', table: 2, row: 3, column: 1, overwrite: false }
    popupAsk.mockResolvedValue({
      kind: 'result',
      result: {
        placement: chosen,
        pages: [{ index: 1, location: 'document.xml · ¶2', text: 'Town' }],
      },
    })
    const session = await inspected()
    await call('choose', 't1', { session })
    expect(parsed(await call('propose', 't1', { session })).needsConfirmation).toBe(false)
    expect((await call('apply', 't1', { session, placement: { kind: 'docx-end' } })).isError).toBe(
      true,
    )
    await call('apply', 't1', { session })
    expect(api.write.mock.calls[0]![2]).toEqual(chosen)
  })

  it('passes the confirmed table payload from the popup to Word', async () => {
    const reading = parseAiPageResponse(
      '<page-content>\n<table><tr><td>Busan</td><td>23</td></tr></table>\n</page-content>',
      { page: 1, pageFingerprint: '' },
    )
    if (!reading.ok) throw Error('invalid fixture')
    const form = reading.reading.payload
    popupAsk.mockResolvedValue({
      kind: 'result',
      result: {
        picturePlacement: 'docx-after-images',
        pages: [{ index: 1, location: 'document.xml · ¶2', text: 'Busan\n23', form }],
      },
    })
    const session = await inspected()
    await call('choose', 't1', { session })
    await call('propose', 't2', { session })
    await call('apply', 't3', { session })
    expect(api.write.mock.calls[0]![1]).toEqual([{ index: 1, payload: form }])
  })

  it('keeps the boxes a popup reading carries, and proposes them over the picture', async () => {
    popupAsk.mockResolvedValue({
      kind: 'result',
      result: {
        pages: [{ index: 1, location: 'document.xml · ¶2', text: 'Shop name', boxes: [BOX] }],
      },
    })
    const session = await inspected()
    await call('choose', 't1', { session })
    const proposal = parsed(await call('propose', 't2', { session }))
    expect(proposal.placement).toMatchObject({ kind: 'docx-image-boxes' })
    expect(proposal.placement.images[0]).toEqual({ index: 1, boxes: [BOX] })
  })

  it('stays plain text for a popup reading without boxes', async () => {
    popupAsk.mockResolvedValue({
      kind: 'result',
      result: { pages: [{ index: 2, location: 'x', text: 'Plain' }] },
    })
    const session = await inspected()
    await call('choose', 't1', { session })
    const proposal = parsed(await call('propose', 't2', { session }))
    expect(proposal.placement).toEqual({ kind: 'docx-after-images' })
  })
})

describe('the popup result check with boxes', () => {
  const page = (boxes: unknown) => ({
    pages: [{ index: 1, location: 'x', text: 'Shop', boxes }],
  })

  it.each(['docx-before-images', 'docx-next-page'])('accepts %s through popup IPC', (kind) => {
    const placement = { kind }
    expect(
      checkOcrPopupResult({ ...page([BOX]), placement, picturePlacement: kind }),
    ).toMatchObject({
      placement,
      picturePlacement: kind,
    })
  })

  it('takes the boxes of a page and keeps them', () => {
    expect(checkOcrPopupResult(page([BOX])).pages[0]!.boxes).toEqual([BOX])
  })

  it('refuses boxes that are not boxes', () => {
    expect(() => checkOcrPopupResult(page('nope'))).toThrow()
    expect(() => checkOcrPopupResult(page([{ ...BOX, x: 'left' }]))).toThrow()
    expect(() => checkOcrPopupResult(page(Array.from({ length: 61 }, () => BOX)))).toThrow()
  })
})
