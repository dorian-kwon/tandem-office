import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createOcrChatService } from '../src/main/translate/ocr-chat'
import { TranslateIpcError } from '../src/shared/translate-api'

/**
 * When a step of the chat OCR fails, the model and the person are told why: the reasons the app
 * itself gives (a refused placement, an expired run, a changed source) are passed on, and
 * anything else stays a general failure that names the step but never a path or a system text.
 */

let api: Record<string, ReturnType<typeof vi.fn>>
let service: ReturnType<typeof createOcrChatService>

const context = { docPath: '/p/source/book.docx', projectRoot: '/p' }

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  api = {
    prepare: vi.fn(async () => ({
      token: 'lease',
      kind: 'embedded',
      format: 'docx',
      tables: [],
      items: [{ index: 1, name: 'a.png', location: 'document.xml · ¶2' }],
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
  service = createOcrChatService({
    ocr: api as never,
    resolve: async () => ({ dir: '/p', file: 'book.docx' }),
    route: () => ({ provider: 'claude-code', model: 'test', paid: false }),
    ask: vi.fn(async () => '<page-content>\nText\n</page-content>'),
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

describe('why a chat OCR step failed', () => {
  it('passes on the reason the app gave for refusing the placement', async () => {
    api.write.mockRejectedValue(
      new TranslateIpcError(
        'INVALID_ARGUMENT',
        'a picture needs between one and the allowed number of boxes inside it',
      ),
    )
    const session = await proposed()
    const answer = await call('apply', 't3', { session })
    expect(answer.isError).toBe(true)
    const { error } = parsed(answer)
    expect(error).toContain('INVALID_ARGUMENT')
    expect(error).toContain('a picture needs between one and the allowed number of boxes')
    // the person is also told nothing was written
    expect(error).toMatch(/no document was (changed|written)|nothing was written/i)
  })

  it('names the step that failed for any other error, and leaves out paths and system texts', async () => {
    api.write.mockRejectedValue(new Error("EACCES: permission denied, open '/Users/me/out.docx'"))
    const session = await proposed()
    const { error } = parsed(await call('apply', 't3', { session }))
    expect(error).toMatch(/apply/i)
    expect(error).not.toContain('/Users/')
    expect(error).not.toContain('EACCES')
  })

  it('does not pass on an unclassified error of the app', async () => {
    api.write.mockRejectedValue(new TranslateIpcError('UNKNOWN', 'failed at /Users/me/secret.docx'))
    const session = await proposed()
    const { error } = parsed(await call('apply', 't3', { session }))
    expect(error).not.toContain('/Users/')
    expect(error).not.toContain('UNKNOWN')
  })

  it('takes a path out of a reason it passes on', async () => {
    api.write.mockRejectedValue(
      new TranslateIpcError('OCR_FAILED', 'the file C:\\Users\\me\\a.docx could not be written'),
    )
    const session = await proposed()
    const { error } = parsed(await call('apply', 't3', { session }))
    expect(error).toContain('OCR_FAILED')
    expect(error).not.toContain('C:\\Users')
  })

  it('also tells why reading a picture failed', async () => {
    api.pageImage.mockRejectedValue(
      new TranslateIpcError('OCR_EXPIRED', 'this OCR run is no longer available'),
    )
    const session = parsed(await call('inspect', 't1')).session as string
    const { error } = parsed(await call('read', 't2', { session, pages: [1] }))
    expect(error).toContain('OCR_EXPIRED')
  })

  it('writes the failure to the log with the step, for the person who looks into it', async () => {
    api.write.mockRejectedValue(new TranslateIpcError('SOURCE_CHANGED', 'the OCR source changed'))
    const session = await proposed()
    await call('apply', 't3', { session })
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('document_ocr'),
      'apply',
      expect.anything(),
    )
  })
})
