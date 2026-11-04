import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveProject, loadProject } from '@genoffice/translate-project'
import { EventEmitter } from 'node:events'
import JSZip from 'jszip'
import {
  createTranslateHandlers,
  registerTranslateIpc,
  type TranslateIpcDeps,
} from '../src/main/translate/translate-ipc'
import type { OcrServiceDeps } from '../src/main/translate/ocr'
import { parseTranslateError, TRANSLATE_CHANNELS } from '../src/shared/translate-api'

/**
 * The OCR bridge handlers over a real project folder: prepare, start, page
 * images, writing the Word document into output/. PDF rendering and the
 * Markdown → .docx conversion are fakes; nothing calls an AI here.
 */

let root: string
let settingsPath: string
let dir: string
let clock: number
let ocrDeps: OcrServiceDeps & {
  pdfPageCount: ReturnType<typeof vi.fn>
  renderPdfPage: ReturnType<typeof vi.fn>
  markdownToDocx: ReturnType<typeof vi.fn>
}

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9])
const PAYLOAD = (text: string) => ({
  version: 1,
  blocks: [{ kind: 'paragraph', runs: [{ kind: 'text', text }] }],
  footnotes: [],
  droppedRepetitions: 0,
  reasked: false,
})

let tokenSeq = 0
function handlers(extra: Partial<TranslateIpcDeps> = {}) {
  return createTranslateHandlers({
    settingsPath: () => settingsPath,
    now: () => clock,
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    newToken: () => `t${++tokenSeq}`,
    ocr: ocrDeps,
    ...extra,
  })
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (err) {
    return parseTranslateError(err).code
  }
  return 'resolved'
}

/** a project folder with these sources (files written into source/) */
async function project(
  sources: Array<{ file: string; kind: 'pdf' | 'scan' | 'image' | 'editable'; bytes: Uint8Array }>,
  ocr: { kind: 'off' } | { kind: 'ai'; provider: 'claude' | 'chatgpt' } = {
    kind: 'ai',
    provider: 'claude',
  },
) {
  for (const sub of ['source', 'references', 'glossary', 'output', '.tandem'])
    mkdirp(join(dir, sub))
  for (const s of sources) writeFileSync(join(dir, 'source', s.file), s.bytes)
  await saveProject(dir, {
    version: 1,
    name: 'P',
    sourceLang: 'en',
    targetLang: 'ko',
    projectPrompt: '',
    ocr,
    sources: await Promise.all(
      sources.map(async (s) => ({ file: s.file, kind: s.kind, sha256: await sha(s.bytes) })),
    ),
    references: [],
    glossaryFiles: [],
  })
}

function mkdirp(path: string) {
  mkdirSync(path, { recursive: true })
}

async function sha(bytes: Uint8Array): Promise<string> {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(bytes).digest('hex')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'translate-ocr-main-'))
  settingsPath = join(root, 'app-settings.json')
  dir = join(root, 'Project')
  clock = 1_000
  writeFileSync(settingsPath, JSON.stringify({ translationProjects: [{ dir, lastOpened: 1 }] }))
  ocrDeps = {
    pdfPageCount: vi.fn(async () => 4),
    renderPdfPage: vi.fn(async () => PNG),
    markdownToDocx: vi.fn(async (markdown: string) => new TextEncoder().encode(`DOCX:${markdown}`)),
  }
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('translate:ocr-* handlers', () => {
  it('prepare lists the pages of a scanned PDF with the project OCR setting', async () => {
    await project([{ file: 'scan.pdf', kind: 'scan', bytes: new Uint8Array([1]) }], {
      kind: 'ai',
      provider: 'chatgpt',
    })
    const out = await handlers().ocrPrepare({ dir, files: ['scan.pdf'] })
    expect(out.kind).toBe('pdf')
    expect(out.ocr).toEqual({ kind: 'ai', provider: 'chatgpt' })
    expect(out.items.map((i) => i.index)).toEqual([1, 2, 3, 4])
    expect(ocrDeps.pdfPageCount).toHaveBeenCalledWith(join(dir, 'source', 'scan.pdf'))
  })

  it('prepare lists several images by name in the given order', async () => {
    await project([
      { file: 'b.jpg', kind: 'image', bytes: JPEG },
      { file: 'a.png', kind: 'image', bytes: PNG },
    ])
    const out = await handlers().ocrPrepare({ dir, files: ['a.png', 'b.jpg'] })
    expect(out.kind).toBe('images')
    expect(out.items).toEqual([
      { index: 1, name: 'a.png' },
      { index: 2, name: 'b.jpg' },
    ])
  })

  it('prepare refuses a project whose OCR is off', async () => {
    await project([{ file: 'scan.pdf', kind: 'scan', bytes: new Uint8Array([1]) }], {
      kind: 'off',
    })
    expect(await codeOf(handlers().ocrPrepare({ dir, files: ['scan.pdf'] }))).toBe('OCR_DISABLED')
  })

  it('prepare refuses an unregistered folder, an unlisted file and a mixed pick', async () => {
    await project([
      { file: 'scan.pdf', kind: 'scan', bytes: new Uint8Array([1]) },
      { file: 'a.png', kind: 'image', bytes: PNG },
      { file: 'doc.odt', kind: 'editable', bytes: new Uint8Array([1]) },
    ])
    const h = handlers()
    expect(await codeOf(h.ocrPrepare({ dir: join(root, 'other'), files: ['scan.pdf'] }))).toBe(
      'NOT_REGISTERED',
    )
    expect(await codeOf(h.ocrPrepare({ dir, files: ['nope.pdf'] }))).toBe('NOT_LISTED')
    expect(await codeOf(h.ocrPrepare({ dir, files: ['scan.pdf', 'a.png'] }))).toBe(
      'INVALID_ARGUMENT',
    )
    expect(await codeOf(h.ocrPrepare({ dir, files: ['doc.odt'] }))).toBe('SOURCE_NOT_EDITABLE')
    expect(await codeOf(h.ocrPrepare({ dir, files: [] }))).toBe('INVALID_ARGUMENT')
  })

  it('page images are served only after start and only for the selected items', async () => {
    await project([{ file: 'scan.pdf', kind: 'scan', bytes: new Uint8Array([1]) }])
    const h = handlers()
    const { token } = await h.ocrPrepare({ dir, files: ['scan.pdf'] })
    expect(await codeOf(h.ocrPageImage({ token, index: 1 }))).toBe('INVALID_ARGUMENT')
    expect(ocrDeps.renderPdfPage).not.toHaveBeenCalled()
    await h.ocrStart({ token, pages: [2, 3] })
    const image = await h.ocrPageImage({ token, index: 2 })
    expect(image.mime).toBe('image/png')
    expect(ocrDeps.renderPdfPage).toHaveBeenCalledWith(join(dir, 'source', 'scan.pdf'), 2)
    expect(await codeOf(h.ocrPageImage({ token, index: 1 }))).toBe('INVALID_ARGUMENT')
  })

  it('start refuses an empty or invalid selection', async () => {
    await project([{ file: 'scan.pdf', kind: 'scan', bytes: new Uint8Array([1]) }])
    const h = handlers()
    const { token } = await h.ocrPrepare({ dir, files: ['scan.pdf'] })
    expect(await codeOf(h.ocrStart({ token, pages: [] }))).toBe('EMPTY_SELECTION')
    expect(await codeOf(h.ocrStart({ token, pages: [5] }))).toBe('INVALID_ARGUMENT')
    expect(await codeOf(h.ocrStart({ token, pages: [1, 1] }))).toBe('INVALID_ARGUMENT')
    expect(await codeOf(h.ocrStart({ token, pages: [1.5] }))).toBe('INVALID_ARGUMENT')
    expect(await codeOf(h.ocrStart({ token: 'nope', pages: [1] }))).toBe('OCR_EXPIRED')
  })

  it('an image is served as its own bytes with the type its content shows', async () => {
    await project([
      { file: 'a.png', kind: 'image', bytes: PNG },
      { file: 'b.jpg', kind: 'image', bytes: JPEG },
    ])
    const h = handlers()
    const { token } = await h.ocrPrepare({ dir, files: ['a.png', 'b.jpg'] })
    await h.ocrStart({ token, pages: [2] })
    const image = await h.ocrPageImage({ token, index: 2 })
    expect(image.mime).toBe('image/jpeg')
    expect([...image.data]).toEqual([...JPEG])
  })

  it('runOcr writes a docx into output/ and returns its path', async () => {
    await project([{ file: 'scan.pdf', kind: 'scan', bytes: new Uint8Array([1]) }])
    const h = handlers()
    const { token } = await h.ocrPrepare({ dir, files: ['scan.pdf'] })
    await h.ocrStart({ token, pages: [1, 3] })
    const out = await h.ocrWrite({
      token,
      pages: [
        { index: 3, payload: PAYLOAD('third') },
        { index: 1, payload: PAYLOAD('first') },
      ],
    })
    expect(out.outputPath).toBe(join(dir, 'output', 'scan (OCR).docx'))
    const written = readFileSync(out.outputPath, 'utf8')
    expect(written.indexOf('first')).toBeGreaterThan(-1)
    expect(written.indexOf('first')).toBeLessThan(written.indexOf('third'))
    // the lease is used up
    expect(await codeOf(h.ocrPageImage({ token, index: 1 }))).toBe('OCR_EXPIRED')
  })

  it('never overwrites an existing output file', async () => {
    await project([{ file: 'scan.pdf', kind: 'scan', bytes: new Uint8Array([1]) }])
    writeFileSync(join(dir, 'output', 'scan (OCR).docx'), 'mine')
    const h = handlers()
    const { token } = await h.ocrPrepare({ dir, files: ['scan.pdf'] })
    await h.ocrStart({ token, pages: [1] })
    const out = await h.ocrWrite({ token, pages: [{ index: 1, payload: PAYLOAD('x') }] })
    expect(out.outputPath).toBe(join(dir, 'output', 'scan (OCR) (2).docx'))
    expect(readFileSync(join(dir, 'output', 'scan (OCR).docx'), 'utf8')).toBe('mine')
    expect(readdirSync(join(dir, 'output')).sort()).toEqual([
      'scan (OCR) (2).docx',
      'scan (OCR).docx',
    ])
  })

  it('write refuses a page that was not selected or a payload the engine cannot read', async () => {
    await project([{ file: 'scan.pdf', kind: 'scan', bytes: new Uint8Array([1]) }])
    const h = handlers()
    const { token } = await h.ocrPrepare({ dir, files: ['scan.pdf'] })
    await h.ocrStart({ token, pages: [1] })
    expect(await codeOf(h.ocrWrite({ token, pages: [{ index: 2, payload: PAYLOAD('x') }] }))).toBe(
      'INVALID_ARGUMENT',
    )
    expect(await codeOf(h.ocrWrite({ token, pages: [{ index: 1, payload: { bad: 1 } }] }))).toBe(
      'INVALID_ARGUMENT',
    )
    expect(await codeOf(h.ocrWrite({ token, pages: [] }))).toBe('INVALID_ARGUMENT')
    expect(ocrDeps.markdownToDocx).not.toHaveBeenCalled()
  })

  it('one OCR run per project at a time', async () => {
    await project([{ file: 'scan.pdf', kind: 'scan', bytes: new Uint8Array([1]) }])
    const h = handlers()
    const first = await h.ocrPrepare({ dir, files: ['scan.pdf'] })
    await h.ocrStart({ token: first.token, pages: [1] })
    expect(await codeOf(h.ocrPrepare({ dir, files: ['scan.pdf'] }))).toBe('OCR_BUSY')
    await h.ocrRelease(first.token)
    const second = await h.ocrPrepare({ dir, files: ['scan.pdf'] })
    expect(second.token).not.toBe(first.token)
  })

  it('a run nobody touched for a long time no longer blocks the project', async () => {
    await project([{ file: 'scan.pdf', kind: 'scan', bytes: new Uint8Array([1]) }])
    const h = handlers()
    const first = await h.ocrPrepare({ dir, files: ['scan.pdf'] })
    await h.ocrStart({ token: first.token, pages: [1] })
    clock += 31 * 60_000
    await expect(h.ocrPrepare({ dir, files: ['scan.pdf'] })).resolves.toBeTruthy()
    expect(await codeOf(h.ocrPageImage({ token: first.token, index: 1 }))).toBe('OCR_EXPIRED')
  })

  it('a missing source copy is refused', async () => {
    await project([{ file: 'scan.pdf', kind: 'scan', bytes: new Uint8Array([1]) }])
    rmSync(join(dir, 'source', 'scan.pdf'))
    expect(await codeOf(handlers().ocrPrepare({ dir, files: ['scan.pdf'] }))).toBe('SOURCE_MISSING')
  })

  it('without the OCR dependencies the channels refuse', async () => {
    await project([{ file: 'scan.pdf', kind: 'scan', bytes: new Uint8Array([1]) }])
    const h = createTranslateHandlers({
      settingsPath: () => settingsPath,
      now: () => clock,
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    })
    expect(await codeOf(h.ocrPrepare({ dir, files: ['scan.pdf'] }))).toBe('OCR_FAILED')
  })

  it('channel names are prefixed translate:', () => {
    for (const key of ['ocrPrepare', 'ocrStart', 'ocrPageImage', 'ocrWrite', 'ocrRelease'] as const)
      expect(TRANSLATE_CHANNELS[key]).toMatch(/^translate:ocr-/)
  })

  it('reading the project never changes its OCR setting', async () => {
    await project([{ file: 'scan.pdf', kind: 'scan', bytes: new Uint8Array([1]) }])
    await handlers().ocrPrepare({ dir, files: ['scan.pdf'] })
    expect((await loadProject(dir)).ocr).toEqual({ kind: 'ai', provider: 'claude' })
  })

  describe('the OCR choice is checked again when the run starts', () => {
    async function setOcr(ocr: { kind: 'off' } | { kind: 'ai'; provider: 'claude' | 'chatgpt' }) {
      await saveProject(dir, { ...(await loadProject(dir)), ocr })
    }

    it('OCR switched off after listing: start is refused and no image is served', async () => {
      await project([{ file: 'scan.pdf', kind: 'scan', bytes: new Uint8Array([1]) }])
      const h = handlers()
      const { token } = await h.ocrPrepare({ dir, files: ['scan.pdf'] })
      await setOcr({ kind: 'off' })
      expect(await codeOf(h.ocrStart({ token, pages: [1] }))).toBe('OCR_DISABLED')
      expect(await codeOf(h.ocrPageImage({ token, index: 1 }))).toBe('OCR_EXPIRED')
      expect(ocrDeps.renderPdfPage).not.toHaveBeenCalled()
    })

    it('provider changed after listing: start is refused as expired', async () => {
      await project([{ file: 'scan.pdf', kind: 'scan', bytes: new Uint8Array([1]) }])
      const h = handlers()
      const { token } = await h.ocrPrepare({ dir, files: ['scan.pdf'] })
      await setOcr({ kind: 'ai', provider: 'chatgpt' })
      expect(await codeOf(h.ocrStart({ token, pages: [1] }))).toBe('OCR_EXPIRED')
      expect(await codeOf(h.ocrPageImage({ token, index: 1 }))).toBe('OCR_EXPIRED')
      expect(ocrDeps.renderPdfPage).not.toHaveBeenCalled()
    })

    it('an unchanged choice runs', async () => {
      await project([{ file: 'scan.pdf', kind: 'scan', bytes: new Uint8Array([1]) }])
      const h = handlers()
      const { token } = await h.ocrPrepare({ dir, files: ['scan.pdf'] })
      // saved again with the same choice
      await setOcr({ kind: 'ai', provider: 'claude' })
      await h.ocrStart({ token, pages: [1] })
      await expect(h.ocrPageImage({ token, index: 1 })).resolves.toMatchObject({
        mime: 'image/png',
      })
    })
  })

  describe('a listing belongs to the window that made it', () => {
    function wire() {
      const handlersByChannel = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
      registerTranslateIpc(
        {
          handle: (channel: string, fn: never) => void handlersByChannel.set(channel, fn),
        } as never,
        {
          settingsPath: () => settingsPath,
          now: () => clock,
          showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
          newToken: () => `t${++tokenSeq}`,
          ocr: ocrDeps,
        },
        () => true,
      )
      const sender = Object.assign(new EventEmitter(), { id: 7 })
      const call = (channel: string, arg: unknown) =>
        handlersByChannel.get(channel)!({ sender }, arg) as Promise<never>
      return { sender, call }
    }

    it('closing the window ends its started run at once', async () => {
      await project([{ file: 'scan.pdf', kind: 'scan', bytes: new Uint8Array([1]) }])
      const { sender, call } = wire()
      const { token } = (await call(TRANSLATE_CHANNELS.ocrPrepare, {
        dir,
        files: ['scan.pdf'],
      })) as { token: string }
      await call(TRANSLATE_CHANNELS.ocrStart, { token, pages: [1] })
      expect(await codeOf(call(TRANSLATE_CHANNELS.ocrPrepare, { dir, files: ['scan.pdf'] }))).toBe(
        'OCR_BUSY',
      )
      sender.emit('destroyed')
      expect(await codeOf(call(TRANSLATE_CHANNELS.ocrPageImage, { token, index: 1 }))).toBe(
        'OCR_EXPIRED',
      )
      await expect(
        call(TRANSLATE_CHANNELS.ocrPrepare, { dir, files: ['scan.pdf'] }),
      ).resolves.toBeTruthy()
    })

    it('a crashed renderer ends its run too', async () => {
      await project([{ file: 'scan.pdf', kind: 'scan', bytes: new Uint8Array([1]) }])
      const { sender, call } = wire()
      const { token } = (await call(TRANSLATE_CHANNELS.ocrPrepare, {
        dir,
        files: ['scan.pdf'],
      })) as { token: string }
      await call(TRANSLATE_CHANNELS.ocrStart, { token, pages: [1] })
      sender.emit('render-process-gone')
      expect(await codeOf(call(TRANSLATE_CHANNELS.ocrStart, { token, pages: [1] }))).toBe(
        'OCR_EXPIRED',
      )
    })
  })
})

async function embeddedDoc(width = 10, height = 10) {
  const zip = new JSZip()
  zip.file('word/document.xml', '<w:p><a:blip r:embed="a"/></w:p><w:p><a:blip r:embed="b"/></w:p>')
  zip.file(
    'word/_rels/document.xml.rels',
    '<Relationships><Relationship Id="a" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/a.png"/><Relationship Id="b" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/b.png"/></Relationships>',
  )
  const image = Buffer.concat([PNG, Buffer.alloc(3000, 1)])
  image.write('IHDR', 12)
  image.writeUInt32BE(width, 16)
  image.writeUInt32BE(height, 20)
  for (const name of ['a', 'b']) zip.file(`word/media/${name}.png`, image)
  return zip.generateAsync({ type: 'nodebuffer' })
}

it('lists embedded images, previews locally and serves only confirmed selections', async () => {
  await project([{ file: 'pictures.docx', kind: 'editable', bytes: await embeddedDoc() }])
  const thumbnail = vi.fn(() => PNG)
  const h = handlers({ ocr: { ...ocrDeps, thumbnail } })
  const listing = await h.ocrPrepare({ dir, files: ['pictures.docx'] })
  expect(listing.kind).toBe('embedded')
  expect(listing.items.map((i) => i.name)).toEqual(['a.png', 'b.png'])
  expect(listing.items[1]!.location).toContain('¶2')
  expect(await codeOf(h.ocrPageImage({ token: listing.token, index: 1 }))).toBe('INVALID_ARGUMENT')
  const preview = await h.ocrPreview({ token: listing.token, index: 2 })
  expect(preview).toEqual({ data: PNG, mime: 'image/png' })
  expect(thumbnail).toHaveBeenCalledTimes(1)
  await h.ocrStart({ token: listing.token, pages: [2] })
  expect(await codeOf(h.ocrPageImage({ token: listing.token, index: 1 }))).toBe('INVALID_ARGUMENT')
  expect((await h.ocrPageImage({ token: listing.token, index: 2 })).data.length).toBeGreaterThan(
    3000,
  )
  const result = await h.ocrWrite({
    token: listing.token,
    pages: [{ index: 2, payload: PAYLOAD('Menu text') }],
    placement: { kind: 'docx-after-images' },
  })
  expect(result.outputPath).toContain('output')
  expect(ocrDeps.markdownToDocx).not.toHaveBeenCalled()
  const written = await JSZip.loadAsync(readFileSync(result.outputPath))
  expect(await written.file('word/document.xml')!.async('string')).toContain('Menu text')
})

it('refuses changed embedded sources before serving images', async () => {
  await project([{ file: 'pictures.docx', kind: 'editable', bytes: await embeddedDoc() }])
  const h = handlers()
  const listing = await h.ocrPrepare({ dir, files: ['pictures.docx'] })
  writeFileSync(join(dir, 'source', 'pictures.docx'), 'changed')
  expect(await codeOf(h.ocrStart({ token: listing.token, pages: [1] }))).toBe('SOURCE_CHANGED')
  expect(await codeOf(h.ocrPrepare({ dir, files: ['pictures.docx'] }))).toBe('SOURCE_CHANGED')
})

it('refuses symlinked embedded sources even when their bytes match the original', async () => {
  const bytes = await embeddedDoc()
  await project([{ file: 'pictures.docx', kind: 'editable', bytes }])
  const outside = join(root, 'outside.docx')
  writeFileSync(outside, bytes)
  const path = join(dir, 'source', 'pictures.docx')
  rmSync(path)
  symlinkSync(outside, path)
  expect(await codeOf(handlers().ocrPrepare({ dir, files: ['pictures.docx'] }))).toBe(
    'UNSUPPORTED_SOURCE',
  )
})

it('refuses an image if the document changes after the selection was confirmed', async () => {
  const bytes = await embeddedDoc()
  await project([{ file: 'pictures.docx', kind: 'editable', bytes }])
  const h = handlers()
  const listing = await h.ocrPrepare({ dir, files: ['pictures.docx'] })
  await h.ocrStart({ token: listing.token, pages: [1] })
  const changed = Buffer.from(bytes)
  changed[0] = 0
  writeFileSync(join(dir, 'source', 'pictures.docx'), changed)
  expect(await codeOf(h.ocrPageImage({ token: listing.token, index: 1 }))).toBe('SOURCE_CHANGED')
})

it('does not decode a thumbnail with excessive pixel dimensions', async () => {
  await project([{ file: 'pictures.docx', kind: 'editable', bytes: await embeddedDoc(5000, 5000) }])
  const thumbnail = vi.fn(() => PNG)
  const h = handlers({ ocr: { ...ocrDeps, thumbnail } })
  const listing = await h.ocrPrepare({ dir, files: ['pictures.docx'] })
  expect(await h.ocrPreview({ token: listing.token, index: 1 })).toBeNull()
  expect(thumbnail).not.toHaveBeenCalled()
})

describe('large local preview', () => {
  it('serves a bounded local preview of one listed picture and never needs a start or a provider', async () => {
    await project([{ file: 'pictures.docx', kind: 'editable', bytes: await embeddedDoc() }])
    const big = new Uint8Array(1_500_000).fill(7)
    const largePreview = vi.fn(() => big)
    const h = handlers({ ocr: { ...ocrDeps, largePreview } })
    const listing = await h.ocrPrepare({ dir, files: ['pictures.docx'] })
    const out = await h.ocrPreviewLarge({ token: listing.token, index: 2 })
    expect(out).toEqual({ data: big, mime: 'image/jpeg' })
    expect(largePreview).toHaveBeenCalledTimes(1)
    // the lease was not started: the original bytes stay gated
    expect(await codeOf(h.ocrPageImage({ token: listing.token, index: 2 }))).toBe(
      'INVALID_ARGUMENT',
    )
  })

  it('refuses a result above the 2 MB cap, an unknown index, and excessive pixel sizes', async () => {
    await project([{ file: 'pictures.docx', kind: 'editable', bytes: await embeddedDoc() }])
    const h = handlers({
      ocr: { ...ocrDeps, largePreview: () => new Uint8Array(2 * 1024 * 1024 + 1) },
    })
    const listing = await h.ocrPrepare({ dir, files: ['pictures.docx'] })
    expect(await h.ocrPreviewLarge({ token: listing.token, index: 1 })).toBeNull()
    expect(await codeOf(h.ocrPreviewLarge({ token: listing.token, index: 9 }))).toBe(
      'INVALID_ARGUMENT',
    )
  })

  it('does not decode a picture with excessive pixel dimensions', async () => {
    await project([
      { file: 'pictures.docx', kind: 'editable', bytes: await embeddedDoc(5000, 5000) },
    ])
    const largePreview = vi.fn(() => PNG)
    const h = handlers({ ocr: { ...ocrDeps, largePreview } })
    const listing = await h.ocrPrepare({ dir, files: ['pictures.docx'] })
    expect(await h.ocrPreviewLarge({ token: listing.token, index: 1 })).toBeNull()
    expect(largePreview).not.toHaveBeenCalled()
  })
})

describe('ocr popup bridge', () => {
  it('tells the host which popup closed, and is harmless without a listener', async () => {
    const onOcrPopupClosed = vi.fn()
    await handlers({ onOcrPopupClosed }).ocrPopupClosed(42)
    expect(onOcrPopupClosed).toHaveBeenCalledWith(42)
    await expect(handlers().ocrPopupClosed(42)).resolves.toBeUndefined()
  })

  it('passes a checked result, and refuses anything that is not plain bounded text', async () => {
    const onOcrPopupResult = vi.fn()
    const h = handlers({ onOcrPopupResult })
    const good = { pages: [{ index: 1, location: 'S · A7', text: 'hi' }] }
    await h.ocrPopupResult(42, good)
    expect(onOcrPopupResult).toHaveBeenCalledWith(42, good)
    await expect(
      h.ocrPopupResult(42, { pages: [{ index: 0, location: '', text: '' }] }),
    ).rejects.toThrow()
    await expect(h.ocrPopupResult(42, { pages: 'x' })).rejects.toThrow()
    await expect(
      h.ocrPopupResult(42, { pages: [{ index: 1, location: 'a', text: 'x'.repeat(200_001) }] }),
    ).rejects.toThrow()
    expect(onOcrPopupResult).toHaveBeenCalledTimes(1)
  })
})
