import { beforeEach, expect, it, vi } from 'vitest'
import { createOcrChatService } from '../src/main/translate/ocr-chat'
let service: ReturnType<typeof createOcrChatService>
let api: Record<string, ReturnType<typeof vi.fn>>
let ask: ReturnType<typeof vi.fn>
const context = { docPath: '/p/source/book.xlsx', projectRoot: '/p' }
beforeEach(() => {
  api = {
    prepare: vi.fn(async () => ({
      token: 'lease',
      kind: 'embedded',
      format: 'xlsx',
      sheets: ['Sheet1'],
      items: [
        { index: 1, name: 'a.png', location: 'Sheet1 · A7' },
        { index: 2, name: 'b.png', location: 'Sheet1 · A80' },
      ],
      ocr: { kind: 'ai', provider: 'claude' },
    })),
    start: vi.fn(async () => {}),
    pageImage: vi.fn(async () => ({ data: new Uint8Array([1]), mime: 'image/png' })),
    preview: vi.fn(async () => null),
    recommend: vi.fn(async () => ({
      placement: { kind: 'xlsx-cells', sheet: 'Sheet1', cell: 'C7', overwrite: false },
      reason: 'empty-cells',
    })),
    write: vi.fn(async () => ({ outputPath: '/p/output/book (OCR).xlsx' })),
    release: vi.fn(async () => {}),
    forgetOwner: vi.fn(),
  }
  ask = vi.fn(async () => '<page-content>\nRecognised\n</page-content>')
  service = createOcrChatService({
    ocr: api as never,
    resolve: async () => ({ dir: '/p', file: 'book.xlsx' }),
    route: () => ({ provider: 'claude-code', model: 'test', paid: false }),
    ask,
    now: Date.now,
    newToken: () => 'session',
  })
})
async function call(action: string, turnId: string, extra: object = {}) {
  return service.execute(1, { action, turnId, requestId: action + turnId, ...extra }, context)
}
it('keeps scope, selection and applying on distinct human turns without a dialog', async () => {
  const inspected = await call('inspect', 't1')
  const session = JSON.parse(inspected.output).session
  expect(ask).not.toHaveBeenCalled()
  expect(api.write).not.toHaveBeenCalled()
  expect((await call('read', 't1', { session, pages: [1] })).isError).toBe(true)
  await call('list', 't2', { session })
  expect((await call('read', 't2', { session, pages: [1] })).isError).toBe(true)
  expect((await call('read', 't3', { session, pages: [2] })).isError).not.toBe(true)
  expect(ask).toHaveBeenCalledTimes(1)
  expect(api.pageImage).toHaveBeenCalledWith('lease', 2)
  expect(api.write).not.toHaveBeenCalled()
  await call('propose', 't3', { session })
  expect((await call('apply', 't3', { session })).isError).toBe(true)
  const applied = await call('apply', 't4', { session })
  expect(applied.isError).not.toBe(true)
  expect(JSON.parse(applied.output).outputPath).toMatch(/\.xlsx$/)
  expect(api.write).toHaveBeenCalledWith('lease', [expect.objectContaining({ index: 2 })], {
    kind: 'xlsx-cells',
    sheet: 'Sheet1',
    cell: 'C7',
    overwrite: false,
  })
})
it('refuses cross-window tokens and changing documents during negotiation', async () => {
  const session = JSON.parse((await call('inspect', 't1')).output).session
  expect(
    (await service.execute(2, { action: 'list', turnId: 't2', session }, context)).isError,
  ).toBe(true)
  expect(
    (
      await service.execute(
        1,
        { action: 'list', turnId: 't2', session },
        { docPath: '/other.docx', projectRoot: '/other' },
      )
    ).isError,
  ).toBe(true)
  expect(api.pageImage).not.toHaveBeenCalled()
})
it('cancels the active model request and never writes on cancellation', async () => {
  const session = JSON.parse((await call('inspect', 't1')).output).session
  ask.mockImplementation(
    (_route, _request, signal: AbortSignal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
      ),
  )
  const pending = call('read', 't2', { session, pages: [1] })
  await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1))
  await service.execute(1, { action: 'cancel', turnId: 't2', requestId: 'readt2' }, context)
  expect((await pending).isError).toBe(true)
  expect(api.write).not.toHaveBeenCalled()
})
it('keeps corrected or translated text while negotiating a new placement without another AI call', async () => {
  const session = JSON.parse((await call('inspect', 't1')).output).session
  await call('read', 't2', { session, pages: [1] })
  await call('propose', 't2', { session, texts: [{ index: 1, text: 'Reviewed translation' }] })
  const placement = { kind: 'xlsx-cells', sheet: 'Sheet1', cell: 'D7', overwrite: false }
  const changed = await call('propose', 't3', { session, placement })
  expect(JSON.parse(changed.output).texts[0].text).toBe('Reviewed translation')
  expect((await call('apply', 't3', { session })).isError).toBe(true)
  await call('apply', 't4', { session })
  expect(JSON.stringify(api.write.mock.calls[0])).toContain('Reviewed translation')
  expect(ask).toHaveBeenCalledTimes(1)
})
it('discards a staged session when chat asks to cancel it', async () => {
  const session = JSON.parse((await call('inspect', 't1')).output).session
  expect(JSON.parse((await call('cancel', 't2', { session })).output).cancelled).toBe(true)
  expect(api.release).toHaveBeenCalledWith('lease')
  expect((await call('list', 't3', { session })).isError).toBe(true)
  expect(api.write).not.toHaveBeenCalled()
})
it('flags shortened previews and exposes bounded text chunks without more AI calls', async () => {
  const session = JSON.parse((await call('inspect', 't1')).output).session
  await call('read', 't2', { session, pages: [1] })
  const text = 'a'.repeat(2100) + 'END'
  const proposal = JSON.parse(
    (await call('propose', 't2', { session, texts: [{ index: 1, text }] })).output,
  )
  expect(proposal.texts[0].truncated).toBe(true)
  const chunk = JSON.parse(
    (await call('review', 't3', { session, pages: [1], offset: 2000 })).output,
  )
  expect(chunk.text).toBe(text.slice(2000))
  expect(chunk.nextOffset).toBeNull()
  expect(ask).toHaveBeenCalledTimes(1)
})
