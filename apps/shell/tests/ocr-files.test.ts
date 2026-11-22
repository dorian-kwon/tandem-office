import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { PDFDocument, PDFName, PDFDict } from 'pdf-lib'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { withPdfDocument, type PdfiumModule } from '../../../packages/pdf2docx/src/extract/pdfium'
import { convertOcrFile } from '../src/main/ocr-file'
import { ocrTargets } from '../src/main/ocr-targets'
import { ensureOcrEngine, ensurePdfium } from '../src/main/pdf2docx-local'
import { FileConversionSession } from '../src/main/file-conversion'

const sample = fileURLToPath(
  new URL('../../../packages/pdf2docx/ocr-helper/fixtures/smoke-en.png', import.meta.url),
)
const recognize = () => ({
  lines: [
    {
      text: 'Recognized office text',
      confidence: 0.98,
      box: { x0: 0.1, y0: 0.65, x1: 0.8, y1: 0.82 },
    },
  ],
  paperShare: 0.96,
})
let dir: string, m: PdfiumModule
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tandem-ocr-files-'))
  m = await ensurePdfium()
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})
function extracted(bytes: Uint8Array, pageIndex = 0) {
  return withPdfDocument(m, bytes, (doc) => {
    const page = m._FPDF_LoadPage(doc, pageIndex)
    const tp = m._FPDFText_LoadPage(page)
    try {
      return Array.from({ length: m._FPDFText_CountChars(tp) }, (_, i) =>
        String.fromCodePoint(m._FPDFText_GetUnicode(tp, i)),
      ).join('')
    } finally {
      m._FPDFText_ClosePage(tp)
      m._FPDF_ClosePage(page)
    }
  })
}
it('places the original scanned page before its editable text in below mode', async () => {
  const out = join(dir, 'below.docx')
  expect(
    await convertOcrFile(sample, 'docx', out, m, recognize, undefined, false, 'below'),
  ).toEqual([])
  const xml = await (
    await JSZip.loadAsync(await readFile(out))
  )
    .file('word/document.xml')!
    .async('string')
  expect(xml.indexOf('<w:drawing>')).toBeGreaterThan(0)
  expect(xml.indexOf('Recognized office text')).toBeGreaterThan(xml.indexOf('<w:drawing>'))
})
it('keeps the scan image with a searchable text layer and emits editable Word text', async () => {
  const pdf = join(dir, 'scan.pdf'),
    word = join(dir, 'scan.docx')
  expect(await convertOcrFile(sample, 'pdf', pdf, m, recognize)).toEqual([])
  const bytes = await readFile(pdf)
  expect(extracted(bytes)).toContain('Recognized office text')
  const parsed = await PDFDocument.load(bytes)
  const resources = parsed.getPages()[0]!.node.Resources()!
  expect(resources.lookup(PDFName.of('XObject'), PDFDict).keys().length).toBeGreaterThan(0)
  expect(parsed.getPages()).toHaveLength(1)
  expect(await convertOcrFile(sample, 'docx', word, m, recognize)).toEqual([])
  const archive = await JSZip.loadAsync(await readFile(word))
  expect(await archive.file('word/document.xml')?.async('string')).toContain('Recognized')
})
it('keeps digital text intact without OCR and reports empty and unavailable recognizers', async () => {
  const digital = await PDFDocument.create()
  digital.addPage().drawText('Digital native')
  const input = join(dir, 'digital.pdf'),
    out = join(dir, 'digital OCR.pdf')
  await writeFile(input, await digital.save())
  const never = vi.fn(() => null)
  expect(await convertOcrFile(input, 'pdf', out, m, never)).toEqual([])
  expect(never).not.toHaveBeenCalled()
  expect(await readFile(input)).toEqual(await readFile(out))
  await expect(convertOcrFile(sample, 'pdf', out, m, () => ({ lines: [] }))).rejects.toThrow(
    'OCR_NO_TEXT',
  )
  await expect(convertOcrFile(sample, 'docx', out, m, null)).rejects.toThrow('OCR_UNAVAILABLE')
})
it('handles multiple OCR selections independently without replacing existing outputs', async () => {
  const input = join(dir, 'report.png'),
    second = join(dir, 'broken.jpg')
  await writeFile(input, await readFile(sample))
  await writeFile(second, 'not an image')
  const first = join(dir, 'report OCR.pdf')
  await writeFile(first, 'keep')
  const session = new FileConversionSession(ocrTargets, ' OCR')
  const selected = session.pick([input, second])
  const results = await session.run(
    selected.map((f) => f.id),
    'pdf',
    async (i, t, o) => {
      await convertOcrFile(i, t, o, m, recognize)
    },
    () => {},
    () => true,
  )
  expect(results[0]?.outputPath).toBe(join(dir, 'report OCR (2).pdf'))
  expect(results[1]?.error).toBeTruthy()
  expect(await readFile(first, 'utf8')).toBe('keep')
})
it.runIf(process.env.TANDEM_TEST_LOCAL_OCR === '1')(
  'reads the actual fixture using the installed local OCR helper',
  async () => {
    const ocr = ensureOcrEngine()
    expect(ocr).toBeTruthy()
    const out = join(dir, 'native.pdf')
    await convertOcrFile(sample, 'pdf', out, m, ocr)
    expect(extracted(await readFile(out))).toMatch(/Hello|local|OCR|Tandem|test|vision/i)
  },
)

it('preserves rotated cropped mixed-page artwork exactly and does not duplicate existing text on a second pass', async () => {
  const { degrees } = await import('pdf-lib')
  const { renderPageByIndexPng } = await import('../../../packages/pdf2docx/src/extract')
  const pdf = await PDFDocument.create(),
    page = pdf.addPage([480, 370])
  page.setCropBox(30, 20, 400, 300)
  page.setRotation(degrees(90))
  const image = await pdf.embedPng(await readFile(sample))
  page.drawImage(image, { x: 80, y: 55, width: 230, height: 135 })
  page.drawText('Native caption', { x: 65, y: 220, size: 16 })
  const original = await pdf.save()
  const input = join(dir, 'mixed.pdf'),
    output = join(dir, 'mixed OCR.pdf'),
    next = join(dir, 'mixed twice.pdf')
  await writeFile(input, original)
  await convertOcrFile(input, 'pdf', output, m, recognize)
  const bytes = await readFile(output)
  const render = (bytes: Uint8Array) =>
    withPdfDocument(m, bytes, (doc) => renderPageByIndexPng(m, doc, 0, 1)!.data)
  expect(Buffer.from(render(bytes)).equals(Buffer.from(render(original)))).toBe(true)
  expect(extracted(bytes)).toContain('Native caption')
  expect(extracted(bytes)).toContain('Recognized office text')
  await convertOcrFile(output, 'pdf', next, m, recognize)
  expect(extracted(await readFile(next)).match(/Recognized office text/g)).toHaveLength(1)
})

it('recognizes only the requested pages in either output, keeping the rest of the document', async () => {
  const source = await PDFDocument.create()
  const image = await source.embedPng(await readFile(sample))
  for (let i = 0; i < 3; i++)
    source.addPage([image.width, image.height]).drawImage(image, { x: 0, y: 0 })
  const file = join(dir, 'pages.pdf')
  await writeFile(file, await source.save())
  for (const format of ['pdf', 'docx']) {
    const output = join(dir, 'pages OCR.' + format)
    const engine = vi.fn(recognize)
    expect(await convertOcrFile(file, format, output, m, engine, '2, 2–2')).toEqual([])
    expect(engine).toHaveBeenCalledTimes(1)
    const bytes = await readFile(output)
    if (format === 'pdf') {
      expect((await PDFDocument.load(bytes)).getPageCount()).toBe(3)
      expect(extracted(bytes, 0).trim()).toBe('')
      expect(extracted(bytes, 1)).toContain('Recognized office text')
      expect(extracted(bytes, 2).trim()).toBe('')
    } else {
      const xml = await (await JSZip.loadAsync(bytes)).file('word/document.xml')!.async('string')
      expect(xml.match(/Recognized office text/g)).toHaveLength(1)
      expect(xml.match(/<w:drawing>/g)!.length).toBeGreaterThanOrEqual(2)
    }
  }
  const never = vi.fn(recognize)
  for (const invalid of ['0', '4', '2-1', '1,,3', '1e2'])
    await expect(
      convertOcrFile(file, 'pdf', join(dir, 'bad.pdf'), m, never, invalid),
    ).rejects.toThrow('OCR_PAGE_RANGE')
  expect(never).not.toHaveBeenCalled()
})

it.runIf(process.env.TANDEM_TEST_LOCAL_OCR === '1')(
  'recovers horizontal and vertical merged cells from a scanned table into Word',
  async () => {
    const { renderPageByIndexPng } = await import('../../../packages/pdf2docx/src/extract')
    const source = await PDFDocument.create()
    const page = source.addPage([400, 300])
    const rule = (x: number, y: number, x1: number, y1: number) =>
      page.drawLine({ start: { x, y }, end: { x: x1, y: y1 }, thickness: 1 })
    for (const y of [30, 170, 240]) rule(35, y, 365, y)
    rule(195, 100, 365, 100)
    for (const x of [35, 365]) rule(x, 30, x, 240)
    rule(195, 30, 195, 170)
    for (const [text, x, y] of [
      ['Tour schedule', 145, 198],
      ['Busan', 60, 112],
      ['Monday', 216, 128],
      ['Tuesday', 216, 61],
    ] as const)
      page.drawText(text, { x, y, size: 16 })
    const scan = withPdfDocument(m, await source.save(), (doc) =>
      renderPageByIndexPng(m, doc, 0, 2)!,
    )
    const input = join(dir, 'merged-scan.png'),
      output = join(dir, 'merged OCR.docx')
    await writeFile(input, scan.data)
    expect(await convertOcrFile(input, 'docx', output, m, ensureOcrEngine())).toEqual([])
    const xml = await (
      await JSZip.loadAsync(await readFile(output))
    )
      .file('word/document.xml')!
      .async('string')
    expect(xml).toMatch(/<w:gridSpan w:val="2"/)
    expect(xml).toMatch(/<w:vMerge w:val="restart"/)
    for (const content of ['Busan', 'Monday', 'Tuesday']) expect(xml).toContain(content)
  },
)
