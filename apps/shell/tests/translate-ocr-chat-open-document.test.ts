import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createOcrChatService } from '../src/main/translate/ocr-chat'
import { OCR_BOX_INSTRUCTION } from '../src/shared/ocr-boxes'

/**
 * Apply for a Word document that is open in the editor: nothing is written. The chat hands the
 * editor what to place (the pictures with their text and the placement), keeps the session, and the
 * editor puts it into the document on screen. Anything else is written as a new file as before.
 */

let api: Record<string, ReturnType<typeof vi.fn>>
let service: ReturnType<typeof createOcrChatService>
let format: 'docx' | 'xlsx' = 'docx'
let file = 'book.docx'

const context = { docPath: '/p/source/book.docx', projectRoot: '/p' }
const BOX = { x: 0.1, y: 0.2, w: 0.3, h: 0.1, fontHeight: 0.08, text: 'Shop name' }

beforeEach(() => {
  format = 'docx'
  file = 'book.docx'
  const plan = {
    format: 'docx',
    items: [{ index: 1, text: 'Shop name', part: 'word/document.xml', relId: 'a' }],
    placement: { kind: 'docx-image-boxes', images: [{ index: 1, boxes: [BOX] }] },
  }
  api = {
    prepare: vi.fn(async () => ({
      token: 'lease',
      kind: 'embedded',
      format,
      ...(format === 'docx' ? { tables: [] } : { sheets: ['Sheet1'] }),
      items: [{ index: 1, name: 'a.png', location: 'document.xml · ¶2', boxable: true }],
      ocr: { kind: 'ai', provider: 'claude' },
    })),
    start: vi.fn(async () => {}),
    pageImage: vi.fn(async () => ({ data: new Uint8Array([1]), mime: 'image/png' })),
    preview: vi.fn(async () => null),
    recommend: vi.fn(async () => ({
      placement: { kind: 'docx-after-images' },
      reason: 'after-images',
    })),
    place: vi.fn(async () => plan),
    write: vi.fn(async () => ({ outputPath: '/p/output/book (OCR).docx' })),
    release: vi.fn(async () => {}),
    forgetOwner: vi.fn(),
  }
  service = createOcrChatService({
    ocr: api as never,
    resolve: async () => ({ dir: '/p', file }),
    route: () => ({ provider: 'claude-code', model: 'test', paid: false }),
    ask: vi.fn(async (_route: unknown, request: { system: string }) =>
      request.system === OCR_BOX_INSTRUCTION
        ? '<boxes>[{"x":100,"y":200,"w":300,"h":100,"font":80,"text":"Shop name"}]</boxes>'
        : '<page-content>\nPlain\n</page-content>',
    ),
    now: Date.now,
    newToken: () => 'session',
  })
})

async function call(action: string, turnId: string, extra: object = {}) {
  return service.execute(1, { action, turnId, requestId: action + turnId, ...extra }, context)
}
const parsed = (answer: { output: string }) => JSON.parse(answer.output)
async function proposed() {
  const session = parsed(await call('inspect', 't1')).session as string
  await call('read', 't2', { session, pages: [1] })
  await call('propose', 't2', { session })
  return session
}

describe('apply into the document that is open', () => {
  it('hands the editor what to place and writes no file', async () => {
    const session = await proposed()
    const answer = await call('apply', 't3', { session, intoOpenDocument: true })
    expect(answer.isError).not.toBe(true)
    expect(answer.placeInDocument).toEqual({
      format: 'docx',
      items: [{ index: 1, text: 'Shop name', part: 'word/document.xml', relId: 'a' }],
      placement: { kind: 'docx-image-boxes', images: [{ index: 1, boxes: [BOX] }] },
    })
    expect(api.place).toHaveBeenCalledWith(
      'lease',
      [expect.objectContaining({ index: 1 })],
      expect.objectContaining({ kind: 'docx-image-boxes' }),
    )
    expect(api.write).not.toHaveBeenCalled()
    expect(parsed(answer).intoOpenDocument).toBe(true)
  })

  it('keeps the session, so the same reading can still be written as a new file', async () => {
    const session = await proposed()
    await call('apply', 't3', { session, intoOpenDocument: true })
    expect(api.release).not.toHaveBeenCalledWith('lease')
    const written = await call('apply', 't4', { session })
    expect(written.isError).not.toBe(true)
    expect(api.write).toHaveBeenCalledTimes(1)
    expect(parsed(written).outputPath).toMatch(/\(OCR\)\.docx$/)
  })

  it('still needs a later human turn than the proposal', async () => {
    const session = await proposed()
    const answer = await call('apply', 't2', { session, intoOpenDocument: true })
    expect(answer.isError).toBe(true)
    expect(api.place).not.toHaveBeenCalled()
  })

  it('places the way the person chose among the offered ones', async () => {
    const session = await proposed()
    await call('apply', 't3', {
      session,
      intoOpenDocument: true,
      placement: { kind: 'docx-end' },
    })
    expect(api.place.mock.calls[0]![2]).toEqual({ kind: 'docx-end' })
  })

  it('writes a new file for a way that cannot go into an open document (a table cell)', async () => {
    api.recommend.mockResolvedValue({
      placement: { kind: 'docx-table-cell', table: 1, row: 1, column: 1, overwrite: false },
      reason: 'empty-cells',
    })
    const session = parsed(await call('inspect', 't1')).session as string
    await call('read', 't2', { session, pages: [1] })
    await call('propose', 't2', {
      session,
      placement: { kind: 'docx-table-cell', table: 1, row: 1, column: 1, overwrite: false },
    })
    const answer = await call('apply', 't3', { session, intoOpenDocument: true })
    expect(answer.placeInDocument).toBeUndefined()
    expect(api.write).toHaveBeenCalledTimes(1)
  })

  it('writes a new file for a workbook', async () => {
    format = 'xlsx'
    file = 'book.xlsx'
    api.recommend.mockResolvedValue({
      placement: { kind: 'xlsx-cells', sheet: 'Sheet1', cell: 'C7', overwrite: false },
      reason: 'empty-cells',
    })
    const session = parsed(await call('inspect', 't1')).session as string
    await call('read', 't2', { session, pages: [1] })
    await call('propose', 't2', { session })
    const answer = await call('apply', 't3', { session, intoOpenDocument: true })
    expect(answer.placeInDocument).toBeUndefined()
    expect(api.place).not.toHaveBeenCalled()
    expect(api.write).toHaveBeenCalledTimes(1)
  })

  it('writes a new file when the editor did not ask for the open document', async () => {
    const session = await proposed()
    const answer = await call('apply', 't3', { session })
    expect(answer.placeInDocument).toBeUndefined()
    expect(api.place).not.toHaveBeenCalled()
    expect(api.write).toHaveBeenCalledTimes(1)
  })
})
