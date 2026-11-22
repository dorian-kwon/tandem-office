import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { convertPdfFileToPptxLocal } from '../src/main/pdf2pptx-local'
import { convertPdfFileToXlsxLocal } from '../src/main/pdf2xlsx-local'

vi.mock('../src/main/pdf2docx-local', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/pdf2docx-local')>()),
  ensureOcrEngine: () => () => ({
    lines: [
      {
        text: 'Recognized office text',
        confidence: 0.95,
        box: { x0: 0.1, y0: 0.8, x1: 0.6, y1: 0.82 },
      },
    ],
    paperShare: 0.95,
  }),
}))

describe('PDF editor Office exports with local OCR', () => {
  let dir: string
  let scan: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pdf-export-ocr-'))
    scan = join(dir, 'scan.pdf')
    const pdf = await PDFDocument.create()
    const sample = new URL(
      '../../../packages/pdf2docx/ocr-helper/fixtures/smoke-en.png',
      import.meta.url,
    )
    const image = await pdf.embedPng(await readFile(sample))
    pdf.addPage([320, 160]).drawImage(image, { x: 0, y: 0, width: 320, height: 160 })
    await writeFile(scan, await pdf.save())
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes recovered text to editable slide shapes', async () => {
    const result = await convertPdfFileToPptxLocal(scan)
    expect(result.pageResults[0]?.status).toBe('ocr')
    const archive = await JSZip.loadAsync(result.pptx)
    expect(await archive.file('ppt/slides/slide1.xml')!.async('string')).toContain('Recognized')
  })

  it('writes recovered text to worksheet cells', async () => {
    const result = await convertPdfFileToXlsxLocal(scan)
    expect(result.pageResults[0]?.status).toBe('ocr')
    const archive = await JSZip.loadAsync(result.xlsx)
    const strings = archive.file('xl/sharedStrings.xml') ?? archive.file('xl/worksheets/sheet1.xml')
    expect(await strings!.async('string')).toContain('Recognized')
  })
})
