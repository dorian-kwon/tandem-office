import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { createOcrChatService } from '../src/main/translate/ocr-chat'
import { chatOcrSourceResolver } from '../src/main/translate/ocr-chat-source'
import { PICTURE_OCR_INSTRUCTION } from '../src/shared/ocr-picture-instruction'

/**
 * Conversational OCR for the formats that end in a new Word document: a PDF read page by page
 * and a Hangul document (HWP, HWPX) whose pictures are taken out. They have no placement step:
 * the text goes into `output/<name> (OCR).docx` and the original is never written. A `.doc` is not
 * read; the person is told to save it as `.docx`.
 */

let api: Record<string, ReturnType<typeof vi.fn>>
let ask: ReturnType<typeof vi.fn>
let service: ReturnType<typeof createOcrChatService>
let file = 'scan.pdf'
let prepared: Record<string, unknown>

const context = { docPath: '/p/source/scan.pdf', projectRoot: '/p' }

const pdfPrepared = {
  token: 'lease',
  kind: 'pdf',
  items: [
    { index: 1, name: '' },
    { index: 2, name: '' },
  ],
  ocr: { kind: 'ai', provider: 'claude' },
}
const hwpxPrepared = {
  token: 'lease',
  kind: 'extracted',
  items: [
    { index: 1, name: 'image1.png', location: 'section0.xml' },
    { index: 2, name: 'image2.jpg', location: 'section0.xml' },
  ],
  ocr: { kind: 'ai', provider: 'claude' },
}

beforeEach(() => {
  file = 'scan.pdf'
  prepared = pdfPrepared
  api = {
    prepare: vi.fn(async () => prepared),
    start: vi.fn(async () => {}),
    pageImage: vi.fn(async () => ({ data: new Uint8Array([1]), mime: 'image/png' })),
    preview: vi.fn(async () => null),
    recommend: vi.fn(async () => {
      throw new Error('a new Word document has no placement to recommend')
    }),
    write: vi.fn(async () => ({ outputPath: '/p/output/scan (OCR).docx' })),
    release: vi.fn(async () => {}),
    forgetOwner: vi.fn(),
  }
  ask = vi.fn(async () => '<page-content>\nRecognised\n</page-content>')
  service = createOcrChatService({
    ocr: api as never,
    resolve: async () => ({ dir: '/p', file }),
    route: () => ({ provider: 'claude-code', model: 'test', paid: false }),
    ask,
    now: Date.now,
    newToken: () => 'session',
  })
})

async function call(action: string, turnId: string, extra: object = {}) {
  return service.execute(1, { action, turnId, requestId: action + turnId, ...extra }, context)
}
const parsed = (answer: { output: string }) => JSON.parse(answer.output)

describe('inspecting a PDF or a Hangul document in chat', () => {
  it('takes a PDF and counts its pages as the things to read', async () => {
    const answer = await call('inspect', 't1')
    expect(answer.isError).not.toBe(true)
    expect(parsed(answer)).toMatchObject({ file: 'scan.pdf', imageCount: 2, result: 'new-docx' })
    expect(api.prepare).toHaveBeenCalledTimes(1)
  })

  it.each(['form.hwpx', 'form.hwp'])('takes %s and counts its pictures', async (name) => {
    file = name
    prepared = hwpxPrepared
    const answer = await call('inspect', 't1')
    expect(answer.isError).not.toBe(true)
    expect(parsed(answer)).toMatchObject({ file: name, imageCount: 2, result: 'new-docx' })
  })

  it('still tells a Word document that its text goes into the document', async () => {
    file = 'book.docx'
    prepared = {
      ...hwpxPrepared,
      kind: 'embedded',
      format: 'docx',
      tables: [],
    }
    const answer = await call('inspect', 't1')
    expect(answer.isError).not.toBe(true)
    expect(parsed(answer).result).toBeUndefined()
  })

  it('does not read an old .doc and says to save it as .docx', async () => {
    file = 'old.doc'
    const answer = await call('inspect', 't1')
    expect(answer.isError).toBe(true)
    expect(parsed(answer).error).toMatch(/\.docx/)
    expect(parsed(answer).error).toMatch(/save/i)
    expect(api.prepare).not.toHaveBeenCalled()
  })

  it('still refuses a format with no way to read it', async () => {
    file = 'deck.pptx'
    const answer = await call('inspect', 't1')
    expect(answer.isError).toBe(true)
    expect(api.prepare).not.toHaveBeenCalled()
  })

  it('refuses a source the service did not list as readable, such as plain images', async () => {
    prepared = { ...pdfPrepared, kind: 'images' }
    const answer = await call('inspect', 't1')
    expect(answer.isError).toBe(true)
    expect(api.release).toHaveBeenCalledWith('lease')
  })
})

describe('reading and agreeing on a new Word document', () => {
  async function readFirst() {
    const session = parsed(await call('inspect', 't1')).session
    await call('read', 't2', { session, pages: [1] })
    return session
  }

  it('reads PDF pages as pages and Hangul pictures as pictures', async () => {
    const pdf = parsed(await call('inspect', 't1')).session
    await call('read', 't2', { session: pdf, pages: [1] })
    expect(ask.mock.calls[0]![1].system).not.toBe(PICTURE_OCR_INSTRUCTION)

    ask.mockClear()
    file = 'form.hwpx'
    prepared = hwpxPrepared
    const hwpx = parsed(await call('inspect', 't3')).session
    await call('read', 't4', { session: hwpx, pages: [1] })
    expect(ask.mock.calls[0]![1].system).toBe(PICTURE_OCR_INSTRUCTION)
  })

  it('proposes the new document without asking for a placement', async () => {
    const session = await readFirst()
    const proposal = parsed(await call('propose', 't2', { session }))
    expect(api.recommend).not.toHaveBeenCalled()
    expect(proposal.needsConfirmation).toBe(true)
    expect(proposal.result).toBe('new-docx')
    expect(proposal.placement).toBeUndefined()
    expect(proposal.texts[0].text).toContain('Recognised')
  })

  it('ignores a placement the model made up', async () => {
    const session = await readFirst()
    await call('propose', 't2', {
      session,
      placement: { kind: 'docx-after-images' },
    })
    await call('apply', 't3', { session, placement: { kind: 'docx-after-images' } })
    expect(api.write).toHaveBeenCalledTimes(1)
    expect(api.write.mock.calls[0]).toHaveLength(2)
  })

  it('keeps the person apart from the write: apply waits for a later human turn', async () => {
    const session = await readFirst()
    await call('propose', 't2', { session })
    expect((await call('apply', 't2', { session })).isError).toBe(true)
    expect(api.write).not.toHaveBeenCalled()
  })

  it('writes the reviewed text into a new Word document and leaves the original alone', async () => {
    const session = await readFirst()
    await call('propose', 't2', { session, texts: [{ index: 1, text: 'Reviewed' }] })
    const applied = await call('apply', 't3', { session })
    expect(applied.isError).not.toBe(true)
    expect(parsed(applied)).toMatchObject({
      outputPath: '/p/output/scan (OCR).docx',
      sourceUnchanged: true,
      format: 'docx',
    })
    expect(api.write).toHaveBeenCalledWith('lease', [
      expect.objectContaining({ index: 1, payload: expect.anything() }),
    ])
    expect(JSON.stringify(api.write.mock.calls[0])).toContain('Reviewed')
  })

  it('writes a Hangul document the same way', async () => {
    file = 'form.hwpx'
    prepared = hwpxPrepared
    const session = parsed(await call('inspect', 't1')).session
    await call('read', 't2', { session, pages: [2] })
    await call('propose', 't2', { session })
    await call('apply', 't3', { session })
    expect(api.write).toHaveBeenCalledWith('lease', [expect.objectContaining({ index: 2 })])
  })
})

describe('the source the chat takes when no project is open', () => {
  const dirs: string[] = []
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  })
  async function resolveFor(name: string, bytes: Uint8Array) {
    const base = await mkdtemp(join(tmpdir(), 'ieum-chat-source-'))
    dirs.push(base)
    const path = join(base, name)
    await writeFile(path, bytes)
    const resolve = chatOcrSourceResolver(
      () => join(base, 'work'),
      () => ({ kind: 'ai', provider: 'claude' }) as never,
    )
    return resolve(1, { action: 'inspect', turnId: 't1' }, { docPath: path, projectRoot: null })
  }
  async function hwpx(): Promise<Uint8Array> {
    const zip = new JSZip()
    zip.file('mimetype', 'application/hwp+zip')
    zip.file('Contents/section0.xml', '<hs:sec/>')
    return zip.generateAsync({ type: 'uint8array' })
  }

  it('makes a private project copy of a HWPX document', async () => {
    const source = await resolveFor('form.hwpx', await hwpx())
    expect(source).toMatchObject({ file: 'form.hwpx' })
  })

  it('makes a private project copy of a PDF', async () => {
    const source = await resolveFor('scan.pdf', new TextEncoder().encode('%PDF-1.4\n%%EOF\n'))
    expect(source).toMatchObject({ file: 'scan.pdf' })
  })

  it('says to save an old .doc as .docx instead of reading it', async () => {
    await expect(resolveFor('old.doc', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))).rejects.toThrow(
      /\.docx/,
    )
  })

  it('still refuses a presentation', async () => {
    await expect(resolveFor('deck.pptx', new Uint8Array([0x50, 0x4b]))).rejects.toThrow(
      /not supported/,
    )
  })
})
