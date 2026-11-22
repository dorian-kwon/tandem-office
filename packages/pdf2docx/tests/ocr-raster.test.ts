import { PDFDocument, StandardFonts } from 'pdf-lib'
import { describe, expect, it, vi } from 'vitest'
import { extractIrDocument, type OcrLine } from '../src'
import { encodeRgbaPng } from '../src/extract/png'
import { loadPdfium } from './helpers/wasm'
import { decodePngRgba } from './helpers/png-decode'

const width = 240,
  height = 180
const cells = ['Name', 'Amount', 'Alpha', '1234', 'Bravo', '5678']

async function fixture(mixed: boolean) {
  const doc = await PDFDocument.create()
  const page = doc.addPage([width, height])
  const rgba = new Uint8Array(width * height * 4).fill(255)
  const paint = (x: number, y: number, r: number, g: number, b: number) => {
    const i = ((height - y - 1) * width + x) * 4
    rgba.set([r, g, b, 255], i)
  }
  for (const y of [50, 70, 90, 110]) for (let x = 15; x <= 185; x++) paint(x, y, 0, 0, 0)
  for (const x of [15, 100, 185]) for (let y = 50; y <= 110; y++) paint(x, y, 0, 0, 0)
  // Unrecognized photo, either inside the flattened paper scan or independently placed.
  if (!mixed)
    for (let y = 10; y < 33; y++) for (let x = 170; x < 211; x++) paint(x, y, 50, 100, 180)
  if (!mixed) {
    // A window grid inside the photograph should not become an empty office table.
    for (const y of [10, 20, 32]) for (let x = 170; x < 211; x++) paint(x, y, 0, 0, 0)
    for (const x of [170, 190, 210]) for (let y = 10; y < 33; y++) paint(x, y, 0, 0, 0)
  }
  const lines: OcrLine[] = []
  for (let i = 0; i < cells.length; i++) {
    const x = i % 2 === 0 ? 22 : 108,
      y = 98 - 20 * Math.floor(i / 2)
    const box = { x0: x / width, y0: y / height, x1: (x + 33) / width, y1: (y + 8) / height }
    for (let xx = x + 1; xx < x + 32; xx += 4)
      for (let yy = y + 1; yy < y + 6; yy++) paint(xx, yy, 0, 0, 0)
    lines.push({ text: cells[i]!, confidence: 0.98, box })
  }
  const scan = await doc.embedPng(encodeRgbaPng(rgba, width, height))
  page.drawImage(scan, { x: 0, y: 0, width, height })
  if (mixed) {
    const font = await doc.embedFont(StandardFonts.Helvetica)
    page.drawText('Native heading', { font, size: 12, x: 15, y: 152 })
    // A searchable text overlay duplicates one raster cell.
    page.drawText('Alpha', { font, size: 8, x: 22, y: 78 })
    const color = await doc.embedPng(encodeRgbaPng(new Uint8Array([50, 100, 180, 255]), 1, 1))
    page.drawImage(color, { x: 170, y: 10, width: 41, height: 23 })
  }
  return { pdf: await doc.save(), lines }
}

describe('raster text and images', () => {
  it.each([false, true])(
    'keeps the photo and outputs editable cells on a mixed=%s page',
    async (mixed) => {
      const { pdf, lines } = await fixture(mixed)
      const ocr = vi.fn(() => ({ paperShare: 0.9, lines }))
      const result = extractIrDocument(pdf, { pdfium: await loadPdfium(), ocr })
      expect(result.pageResults[0]?.status).toBe('ocr')
      expect(ocr).toHaveBeenCalledTimes(1)
      const blocks = result.irPages[0]!.blocks
      expect(blocks.filter((block) => block.kind === 'table')).toHaveLength(1)
      const table = blocks.find((block) => block.kind === 'table')
      expect(table?.kind).toBe('table')
      const tableText = table!.rows.flatMap((row) =>
        row.map((cell) =>
          cell.blocks.flatMap((b) => b.lines.flatMap((l) => l.spans.map((s) => s.text))).join(''),
        ),
      )
      expect(tableText).toEqual(cells)
      const image = blocks.find((block) => block.kind === 'image')
      expect(image).toBeDefined()
      const pixels = decodePngRgba(image!.data)
      expect(pixels.rgba.some((c, i) => i % 4 === 2 && c === 180)).toBe(true)
      if (mixed)
        expect(
          blocks.some(
            (b) =>
              b.kind === 'text' &&
              b.lines.some((l) => l.spans.some((s) => s.text.includes('Native heading'))),
          ),
        ).toBe(true)
    },
  )

  it('skips OCR on a digital text page', async () => {
    const doc = await PDFDocument.create(),
      page = doc.addPage()
    page.drawText('Editable digital paragraph')
    const ocr = vi.fn(() => null)
    const result = extractIrDocument(await doc.save(), { pdfium: await loadPdfium(), ocr })
    expect(result.pageResults[0]?.status).toBe('ok')
    expect(ocr).not.toHaveBeenCalled()
  })
})
