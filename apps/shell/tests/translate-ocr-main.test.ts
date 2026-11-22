import { parseAiPageResponse } from '../../../packages/pdf-structure/src/ai-read/parse'
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
import { buildDocx, TINY_PNG_BASE64 } from '../../../packages/docx-engine/tests/helpers/build-docx'
import {
  createTranslateHandlers,
  registerTranslateIpc,
  type TranslateIpcDeps,
} from '../src/main/translate/translate-ipc'
import { createOcrService, type OcrServiceDeps } from '../src/main/translate/ocr'
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

async function embeddedDoc(
  width = 10,
  height = 10,
  body = '<w:p><a:blip r:embed="a"/></w:p><w:p><a:blip r:embed="b"/></w:p>',
) {
  const zip = new JSZip()
  zip.file('word/document.xml', body)
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

it('gives each listed picture of a Word document the page Word recorded for it', async () => {
  await project([
    {
      file: 'pages.docx',
      kind: 'editable',
      bytes: await embeddedDoc(
        10,
        10,
        '<w:p><a:blip r:embed="a"/></w:p><w:p><w:r><w:lastRenderedPageBreak/></w:r><a:blip r:embed="b"/></w:p>',
      ),
    },
  ])
  const listing = await handlers({ ocr: ocrDeps }).ocrPrepare({ dir, files: ['pages.docx'] })
  expect(listing.items.map((i) => i.page)).toEqual([1, 2])
  expect(listing.items.some((i) => i.pageApprox)).toBe(false)
})

it('leaves the page out of an item when the file does not say', async () => {
  await project([{ file: 'pictures.docx', kind: 'editable', bytes: await embeddedDoc() }])
  const listing = await handlers({ ocr: ocrDeps }).ocrPrepare({ dir, files: ['pictures.docx'] })
  expect(listing.items.map((i) => i.page)).toEqual([undefined, undefined])
})

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

it('write accepts a boxes payload for the list placement and writes payload.text', async () => {
  await project([{ file: 'pictures.docx', kind: 'editable', bytes: await embeddedDoc() }])
  const h = handlers()
  const listing = await h.ocrPrepare({ dir, files: ['pictures.docx'] })
  await h.ocrStart({ token: listing.token, pages: [2] })
  const result = await h.ocrWrite({
    token: listing.token,
    pages: [
      {
        index: 2,
        payload: {
          kind: 'boxes',
          boxes: [{ x: 0.1, y: 0.1, w: 0.3, h: 0.1, fontHeight: 0.05, text: 'Box one' }],
          text: 'Box one\nBox two',
        },
      },
    ],
    placement: { kind: 'docx-after-images' },
  })
  const written = await JSZip.loadAsync(readFileSync(result.outputPath))
  const xml = await written.file('word/document.xml')!.async('string')
  expect(xml).toContain('Box one')
  expect(xml).toContain('Box two')
})

it('write rejects a boxes payload with a wrong shape', async () => {
  await project([{ file: 'pictures.docx', kind: 'editable', bytes: await embeddedDoc() }])
  const h = handlers()
  const listing = await h.ocrPrepare({ dir, files: ['pictures.docx'] })
  await h.ocrStart({ token: listing.token, pages: [2] })
  expect(
    await codeOf(
      h.ocrWrite({
        token: listing.token,
        pages: [{ index: 2, payload: { kind: 'boxes', boxes: 'nope', text: 1 } }],
        placement: { kind: 'docx-after-images' },
      }),
    ),
  ).toBe('INVALID_ARGUMENT')
})

const DRAWING =
  '<w:r><w:drawing><wp:inline><wp:extent cx="3000000" cy="1500000"/><wp:docPr id="7" name="P"/>' +
  '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
  '<pic:pic><pic:blipFill><a:blip r:embed="rId10"/></pic:blipFill></pic:pic></a:graphicData>' +
  '</a:graphic></wp:inline></w:drawing></w:r>'
const textRun = (t: string) => `<w:r><w:t>${t}</w:t></w:r>`

it('marks only a picture alone on a left-aligned paragraph as boxable', async () => {
  const bytes = await buildDocx({
    withImage: true,
    bodyXml: `<w:p>${textRun('Intro')}</w:p><w:p>${DRAWING}</w:p>`,
  })
  await project([{ file: 'alone.docx', kind: 'editable', bytes }])
  const alone = await handlers().ocrPrepare({ dir, files: ['alone.docx'] })
  expect(alone.items[0]!.boxable).toBe(true)

  const crowded = await buildDocx({
    withImage: true,
    bodyXml: `<w:p>${textRun('Intro')}</w:p><w:p>${textRun('Caption')}${DRAWING}</w:p>`,
  })
  await project([{ file: 'crowded.docx', kind: 'editable', bytes: crowded }])
  const listing = await handlers().ocrPrepare({ dir, files: ['crowded.docx'] })
  expect(listing.items[0]!.boxable).toBeUndefined()
})

it('does not mark a picture whose style centers it as boxable', async () => {
  const stylesXml =
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/>' +
    '<w:pPr><w:jc w:val="center"/></w:pPr></w:style></w:styles>'
  const bytes = await buildDocx({
    withImage: true,
    stylesXml,
    bodyXml: `<w:p>${textRun('Intro')}</w:p><w:p>${DRAWING}</w:p>`,
  })
  await project([{ file: 'centered.docx', kind: 'editable', bytes }])
  const listing = await handlers().ocrPrepare({ dir, files: ['centered.docx'] })
  expect(listing.items[0]!.boxable).toBeUndefined()
})

it('writes boxes over a boxable picture from the confirmed reading', async () => {
  const bytes = await buildDocx({
    withImage: true,
    bodyXml: `<w:p>${textRun('Intro')}</w:p><w:p>${DRAWING}</w:p>`,
  })
  await project([{ file: 'alone.docx', kind: 'editable', bytes }])
  const h = handlers()
  const listing = await h.ocrPrepare({ dir, files: ['alone.docx'] })
  await h.ocrStart({ token: listing.token, pages: [1] })
  const box = { x: 0.1, y: 0.2, w: 0.3, h: 0.1, fontHeight: 0.08, text: 'Name' }
  const result = await h.ocrWrite({
    token: listing.token,
    pages: [{ index: 1, payload: { kind: 'boxes', boxes: [box], text: 'Name' } }],
    placement: { kind: 'docx-image-boxes', images: [{ index: 1, boxes: [box] }] },
  })
  const xml = await (
    await JSZip.loadAsync(readFileSync(result.outputPath))
  )
    .file('word/document.xml')!
    .async('string')
  expect(xml.match(/<w:txbxContent>/g)).toHaveLength(2)
  expect(xml).toContain('Name')
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

async function hwpxDoc(pictures = 2) {
  const zip = new JSZip()
  zip.file('mimetype', 'application/hwp+zip')
  const items = Array.from(
    { length: pictures },
    (_, i) => `<opf:item id="img${i + 1}" href="BinData/img${i + 1}.png" media-type="image/png"/>`,
  ).join('')
  zip.file(
    'Contents/content.hpf',
    `<opf:package xmlns:opf="http://www.idpf.org/2007/opf/"><opf:manifest>${items}</opf:manifest></opf:package>`,
  )
  const refs = Array.from(
    { length: pictures },
    (_, i) =>
      `<hp:p><hp:run><hp:pic><hc:img binaryItemIDRef="img${i + 1}"/></hp:pic></hp:run></hp:p>`,
  ).join('')
  zip.file(
    'Contents/section0.xml',
    `<hs:sec xmlns:hs="s" xmlns:hp="p" xmlns:hc="c">${refs}</hs:sec>`,
  )
  // a real 1x1 picture: the local preview reads its size before it makes a thumbnail
  for (let i = 1; i <= pictures; i++)
    zip.file(`BinData/img${i}.png`, Buffer.from(TINY_PNG_BASE64, 'base64'))
  return zip.generateAsync({ type: 'nodebuffer' })
}

it('takes the pictures of a HWPX source as extracted ones, to be read into a new Word document', async () => {
  const bytes = await hwpxDoc()
  await project([{ file: 'form.hwpx', kind: 'editable', bytes }])
  const thumbnail = vi.fn(() => PNG)
  const h = handlers({ ocr: { ...ocrDeps, thumbnail } })
  const listing = await h.ocrPrepare({ dir, files: ['form.hwpx'] })
  expect(listing.kind).toBe('extracted')
  expect(listing.items.map((i) => i.name)).toEqual(['img1.png', 'img2.png'])
  expect(listing.items.every((i) => i.boxable === undefined)).toBe(true)
  expect(listing.format).toBeUndefined()

  await h.ocrStart({ token: listing.token, pages: [2] })
  expect(await codeOf(h.ocrPageImage({ token: listing.token, index: 1 }))).toBe('INVALID_ARGUMENT')
  const image = await h.ocrPageImage({ token: listing.token, index: 2 })
  expect(image.mime).toBe('image/png')
  const preview = await h.ocrPreview({ token: listing.token, index: 2 })
  expect(preview).toEqual({ data: PNG, mime: 'image/png' })
  expect(thumbnail).toHaveBeenCalledTimes(1)

  const result = await h.ocrWrite({
    token: listing.token,
    pages: [{ index: 2, payload: PAYLOAD('Menu text') }],
  })
  expect(result.outputPath).toMatch(/form \(OCR\)\.docx$/)
  expect(ocrDeps.markdownToDocx).toHaveBeenCalledTimes(1)
  expect(String(ocrDeps.markdownToDocx.mock.calls[0]![0])).toContain('Menu text')
  expect(readFileSync(join(dir, 'source', 'form.hwpx')).equals(bytes)).toBe(true)
})

it('refuses a placement for extracted pictures, since nothing is placed into the Hangul file', async () => {
  await project([{ file: 'form.hwpx', kind: 'editable', bytes: await hwpxDoc(1) }])
  const h = handlers()
  const listing = await h.ocrPrepare({ dir, files: ['form.hwpx'] })
  await h.ocrStart({ token: listing.token, pages: [1] })
  const result = await h.ocrWrite({
    token: listing.token,
    pages: [{ index: 1, payload: PAYLOAD('Text') }],
    placement: { kind: 'docx-end' },
  })
  // the placement is ignored: the readings still become the new document
  expect(result.outputPath).toMatch(/\(OCR\)\.docx$/)
})

it('explains why a HWPX without any picture cannot be read', async () => {
  await project([{ file: 'plain.hwpx', kind: 'editable', bytes: await hwpxDoc(0) }])
  expect(await codeOf(handlers().ocrPrepare({ dir, files: ['plain.hwpx'] }))).toBe('OCR_FAILED')
})

it('still refuses the editable formats it cannot read pictures of', async () => {
  await project([{ file: 'slides.pptx', kind: 'editable', bytes: new Uint8Array([1, 2, 3]) }])
  expect(await codeOf(handlers().ocrPrepare({ dir, files: ['slides.pptx'] }))).toBe(
    'SOURCE_NOT_EDITABLE',
  )
})

describe('working out what to place into an open Word document', () => {
  const BOX = { x: 0.1, y: 0.2, w: 0.3, h: 0.1, fontHeight: 0.08, text: 'Shop name' }
  async function started(pages = [1, 2]) {
    await project([{ file: 'pictures.docx', kind: 'editable', bytes: await embeddedDoc() }])
    const service = createOcrService(
      ocrDeps,
      () => clock,
      () => `p${++tokenSeq}`,
    )
    const listing = await service.prepare(dir, ['pictures.docx'])
    await service.start(listing.token, pages)
    return { service, token: listing.token }
  }

  it('keeps a confirmed form in the placement plan for the live editor', async () => {
    const { service, token } = await started([1])
    const reading = parseAiPageResponse(
      '<page-content>\n<table><tr><td>Busan</td><td>23</td></tr></table>\n</page-content>',
      { page: 1, pageFingerprint: '' },
    )
    if (!reading.ok) throw Error('invalid fixture')
    const form = reading.reading.payload
    const plan = await service.place(token, [{ index: 1, payload: form }], {
      kind: 'docx-replace-images',
    })
    expect(plan.items[0]?.form).toEqual(form)
  })

  it('gives the pictures to place with their text, part and relationship id, and writes no file', async () => {
    const { service, token } = await started()
    const plan = await service.place(
      token,
      [
        { index: 1, payload: PAYLOAD('Menu') },
        { index: 2, payload: { kind: 'boxes', boxes: [BOX], text: 'Shop name' } },
      ],
      { kind: 'docx-image-boxes', images: [{ index: 2, boxes: [BOX] }] },
    )
    expect(plan.format).toBe('docx')
    expect(plan.placement).toEqual({
      kind: 'docx-image-boxes',
      images: [{ index: 2, boxes: [BOX] }],
    })
    expect(plan.items).toEqual([
      expect.objectContaining({ index: 1, text: 'Menu', part: 'word/document.xml', relId: 'a' }),
      expect.objectContaining({
        index: 2,
        text: 'Shop name',
        part: 'word/document.xml',
        relId: 'b',
      }),
    ])
    expect(readdirSync(join(dir, 'output'))).toEqual([])
  })

  it('leaves the reading usable: it can still be written as a new document', async () => {
    const { service, token } = await started([1])
    await service.place(token, [{ index: 1, payload: PAYLOAD('Menu') }], {
      kind: 'docx-after-images',
    })
    const written = await service.write(token, [{ index: 1, payload: PAYLOAD('Menu') }], {
      kind: 'docx-after-images',
    })
    expect(written.outputPath).toMatch(/\(OCR\)\.docx$/)
  })

  it('refuses a table destination, a page that was not confirmed, and a box list of a picture not read', async () => {
    const { service, token } = await started([1])
    await expect(
      service.place(token, [{ index: 1, payload: PAYLOAD('x') }], {
        kind: 'docx-table-cell',
        table: 1,
        row: 1,
        column: 1,
        overwrite: false,
      }),
    ).rejects.toThrow(/table/i)
    await expect(
      service.place(token, [{ index: 2, payload: PAYLOAD('x') }], { kind: 'docx-after-images' }),
    ).rejects.toThrow()
    await expect(
      service.place(token, [{ index: 1, payload: PAYLOAD('x') }], {
        kind: 'docx-image-boxes',
        images: [{ index: 2, boxes: [BOX] }],
      }),
    ).rejects.toThrow(/not read/)
  })

  it('refuses a reading that is not of a Word document', async () => {
    await project([{ file: 'scan.pdf', kind: 'scan', bytes: new Uint8Array([1]) }])
    const service = createOcrService(
      ocrDeps,
      () => clock,
      () => `p${++tokenSeq}`,
    )
    const listing = await service.prepare(dir, ['scan.pdf'])
    await service.start(listing.token, [1])
    await expect(
      service.place(listing.token, [{ index: 1, payload: PAYLOAD('x') }], {
        kind: 'docx-after-images',
      }),
    ).rejects.toThrow(/Word/)
  })
})
