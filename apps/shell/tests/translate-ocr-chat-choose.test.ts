import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createOcrChatService,
  type OcrChatPopup,
  type OcrChatPopupOutcome,
} from '../src/main/translate/ocr-chat'

/**
 * Choosing the pictures in the OCR popup instead of typing numbers in the chat. The popup shows
 * the pictures with local previews, takes the person's confirmation of the start, reads them and
 * hands the text back. The chat tool waits for that and goes on with the text: it is the
 * person's own choice, made on screen, so no model call and no write happens before it.
 */

let api: Record<string, ReturnType<typeof vi.fn>>
let ask: ReturnType<typeof vi.fn>
let popupAsk: ReturnType<typeof vi.fn>
let popup: OcrChatPopup
let service: ReturnType<typeof createOcrChatService>
let file = 'book.docx'
let prepared: Record<string, unknown>

const context = { docPath: '/p/source/book.docx', projectRoot: '/p' }

const docxPrepared = {
  token: 'lease',
  kind: 'embedded',
  format: 'docx',
  tables: [],
  items: [
    { index: 1, name: 'a.png', location: 'document.xml · ¶1', page: 1 },
    { index: 2, name: 'b.png', location: 'document.xml · ¶9', page: 3 },
    { index: 3, name: 'c.png', location: 'document.xml · ¶20', page: 5 },
  ],
  ocr: { kind: 'ai', provider: 'claude' },
}
const pdfPrepared = {
  token: 'lease',
  kind: 'pdf',
  items: [
    { index: 1, name: '' },
    { index: 2, name: '' },
  ],
  ocr: { kind: 'ai', provider: 'claude' },
}

const result = (
  pages: { index: number; text: string }[],
  unread: { index: number; reason: 'empty' | 'failed' }[] = [],
): OcrChatPopupOutcome => ({
  kind: 'result',
  result: {
    pages: pages.map((p) => ({ ...p, location: `loc ${p.index}` })),
    ...(unread.length ? { unread: unread.map((u) => ({ ...u, location: `loc ${u.index}` })) } : {}),
  },
})

beforeEach(() => {
  file = 'book.docx'
  prepared = docxPrepared
  api = {
    prepare: vi.fn(async () => prepared),
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
  ask = vi.fn(async () => '<page-content>\nShould not be called\n</page-content>')
  popupAsk = vi.fn(async () => result([{ index: 2, text: 'Menu\n\nOpening hours' }]))
  popup = { ask: popupAsk as unknown as OcrChatPopup['ask'] }
  service = createOcrChatService({
    ocr: api as never,
    resolve: async () => ({ dir: '/p', file }),
    route: () => ({ provider: 'claude-code', model: 'test', paid: false }),
    ask,
    popup,
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

describe('choosing pictures in the popup', () => {
  it('opens the popup over the asking window for this document and sends nothing itself', async () => {
    const session = await inspected()
    const answer = await call('choose', 't1', { session })
    expect(answer.isError).not.toBe(true)
    expect(popupAsk).toHaveBeenCalledTimes(1)
    expect(popupAsk.mock.calls[0]![0]).toBe(1)
    expect(popupAsk.mock.calls[0]![1]).toEqual({ dir: '/p', file: 'book.docx' })
    expect(ask).not.toHaveBeenCalled()
    expect(api.pageImage).not.toHaveBeenCalled()
    expect(api.write).not.toHaveBeenCalled()
  })

  it('brings back what the person had read there, with the page of each picture', async () => {
    const session = await inspected()
    const answer = parsed(await call('choose', 't1', { session }))
    expect(answer.recognised).toEqual([2])
    expect(answer.results).toEqual([
      expect.objectContaining({
        index: 2,
        page: 3,
        location: 'document.xml · ¶9',
        // the paragraphs are shown one per line
        text: 'Menu\nOpening hours',
      }),
    ])
  })

  it('names the pictures that gave no text, and does not keep an empty reading', async () => {
    popupAsk.mockResolvedValue(
      result(
        [
          { index: 1, text: 'Sign' },
          { index: 3, text: '' },
        ],
        [{ index: 3, reason: 'empty' }],
      ),
    )
    const session = await inspected()
    const answer = parsed(await call('choose', 't1', { session }))
    expect(answer.recognised).toEqual([1])
    expect(answer.unread).toEqual([expect.objectContaining({ index: 3, reason: 'empty' })])
    expect((await call('review', 't2', { session, pages: [3] })).isError).toBe(true)
  })

  it('makes the chat session ready to review, propose and apply what was read', async () => {
    const session = await inspected()
    await call('choose', 't1', { session })
    // the popup read with a lease of its own, so the session takes a fresh one for these pictures
    expect(api.prepare).toHaveBeenCalledTimes(2)
    expect(api.start).toHaveBeenLastCalledWith('lease', [2])
    expect(parsed(await call('review', 't2', { session, pages: [2] })).text).toContain('Menu')
    const proposal = parsed(await call('propose', 't2', { session }))
    expect(proposal.placement).toEqual({ kind: 'docx-after-images' })
    expect((await call('apply', 't2', { session })).isError).toBe(true)
    const applied = await call('apply', 't3', { session })
    expect(applied.isError).not.toBe(true)
    expect(api.write).toHaveBeenCalledWith('lease', [expect.objectContaining({ index: 2 })], {
      kind: 'docx-after-images',
    })
    expect(ask).not.toHaveBeenCalled()
  })

  it('splits the text at blank lines into paragraphs', async () => {
    const session = await inspected()
    await call('choose', 't1', { session })
    await call('propose', 't2', { session })
    await call('apply', 't3', { session })
    const page = api.write.mock.calls[0]![1][0]
    expect(page.payload.blocks).toHaveLength(2)
  })

  it('works for a PDF, which goes into a new Word document without a placement', async () => {
    file = 'scan.pdf'
    prepared = pdfPrepared
    popupAsk.mockResolvedValue(result([{ index: 1, text: 'Page one' }]))
    const session = await inspected()
    await call('choose', 't1', { session })
    const proposal = parsed(await call('propose', 't2', { session }))
    expect(proposal.result).toBe('new-docx')
    expect(api.recommend).not.toHaveBeenCalled()
    await call('apply', 't3', { session })
    expect(api.write.mock.calls[0]).toHaveLength(2)
  })

  it('tells the model when the person closed the popup without reading', async () => {
    popupAsk.mockResolvedValue({ kind: 'closed' })
    const session = await inspected()
    const answer = await call('choose', 't1', { session })
    expect(answer.isError).not.toBe(true)
    expect(parsed(answer)).toMatchObject({ closed: true })
    expect(api.start).not.toHaveBeenCalled()
    expect((await call('propose', 't2', { session })).isError).toBe(true)
  })

  it('says so when the popup is already open or cannot be shown', async () => {
    const session = await inspected()
    popupAsk.mockResolvedValueOnce({ kind: 'already-open' })
    expect(parsed(await call('choose', 't1', { session }))).toMatchObject({ alreadyOpen: true })
    popupAsk.mockResolvedValueOnce({ kind: 'unavailable' })
    const unavailable = await call('choose', 't2', { session })
    expect(unavailable.isError).toBe(true)
    expect(parsed(unavailable).error).toMatch(/list|chat/i)
  })

  it('closes the popup when the run is cancelled, and writes nothing', async () => {
    let seen: AbortSignal | undefined
    popupAsk.mockImplementation(
      (_owner: number, _target: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          seen = signal
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
        }),
    )
    const session = await inspected()
    const pending = call('choose', 't1', { session })
    await vi.waitFor(() => expect(popupAsk).toHaveBeenCalledTimes(1))
    await service.execute(
      1,
      { action: 'cancel', turnId: 't1', requestId: 'choose' + 't1' },
      context,
    )
    expect((await pending).isError).toBe(true)
    expect(seen?.aborted).toBe(true)
    expect(api.write).not.toHaveBeenCalled()
  })

  it('refuses without a session and where no popup is available', async () => {
    expect((await call('choose', 't1', { session: 'nope' })).isError).toBe(true)
    const bare = createOcrChatService({
      ocr: api as never,
      resolve: async () => ({ dir: '/p', file }),
      route: () => ({ provider: 'claude-code', model: 'test', paid: false }),
      ask,
      now: Date.now,
      newToken: () => 'bare',
    })
    const session = parsed(
      await bare.execute(1, { action: 'inspect', turnId: 'a', requestId: 'a' }, context),
    ).session
    const answer = await bare.execute(
      1,
      { action: 'choose', turnId: 'b', requestId: 'b', session },
      context,
    )
    expect(answer.isError).toBe(true)
  })
})
