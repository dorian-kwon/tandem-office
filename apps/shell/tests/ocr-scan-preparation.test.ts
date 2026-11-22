import { expect, it, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { ensurePdfium, ensureOcrEngine } from '../src/main/pdf2docx-local'
import { convertOcrFile } from '../src/main/ocr-file'
import { withAlloc, withPdfDocument } from '../../../packages/pdf2docx/src/extract/pdfium'
import { renderPagePixels } from '../../../packages/pdf2docx/src/extract'
import { turnPixels } from '../../../packages/pdf2docx/src/ocr-rotation'
import { prepareScanOcr } from '../src/main/ocr-scan-preparation'
import * as pngCodec from '../../../packages/pdf2docx/src/extract/png'
import { encodeRgbaPng } from '../../../packages/pdf2docx/src/extract/png'
import type { OcrEngine } from '../../../packages/pdf2docx/src/ocr'

function scan(paper: number, ink: number, slope = 0) {
  const width = 256,
    height = 144
  const rgba = new Uint8Array(width * height * 4).fill(255)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const row = y - Math.round((x - width / 2) * slope)
      const isInk = row >= 12 && row < 130 && row % 18 < 4 && x > 12 && x < 244 && x % 9 < 6
      const i = (y * width + x) * 4
      rgba.fill(isInk ? ink : paper, i, i + 3)
    }
  }
  return { width, height, rgba }
}
const page = { widthPt: 256, heightPt: 144 }
const box = { x0: 0.68, x1: 0.78, y0: 0.4, y1: 0.48 }
const recognized = { lines: [{ text: 'tilted', box, confidence: 1, chars: [{ text: 't', box }] }] }

it('recognizes faded gray paper with a stretched copy and leaves original pixels intact', async () => {
  const p = scan(180, 143)
  const source = encodeRgbaPng(p.rgba, p.width, p.height)
  const engine = vi.fn<OcrEngine>().mockReturnValue(recognized)
  const scanOcr = prepareScanOcr(engine)
  expect(scanOcr.paperThreshold?.(p)).toBeLessThan(180)
  expect(scanOcr(source, page, p)).toEqual(recognized)
  const received = engine.mock.calls[0]![0]
  const orig = scan(180, 143)
  expect(p.rgba).toEqual(orig.rgba)
  const expected = scan(255, 0)
  expect(received).toEqual(encodeRgbaPng(expected.rgba, expected.width, expected.height))
  expect((await (await PDFDocument.create()).embedPng(received)).height).toBe(page.heightPt)
})

it('stretches gray ink on white paper while retaining antialiased edges', () => {
  const pixels = scan(255, 84)
  // Give a small part of each stroke a gray edge, leaving solid strokes
  // available to estimate the foreground level.
  for (let i = 0; i < pixels.rgba.length; i += 28) {
    if (pixels.rgba[i] === 84) pixels.rgba.fill(170, i, i + 3)
  }
  const source = encodeRgbaPng(pixels.rgba, pixels.width, pixels.height)
  const expected = Uint8Array.from(pixels.rgba, (value) =>
    value === 84 ? 0 : value === 170 ? 128 : value,
  )
  const engine = vi.fn<OcrEngine>().mockReturnValue(recognized)
  prepareScanOcr(engine)(source, page, pixels)
  expect(engine).toHaveBeenCalledTimes(1)
  expect(engine.mock.calls[0]![0]).toEqual(encodeRgbaPng(expected, pixels.width, pixels.height))
})

it.each([-4, 4])(
  'deskews a %s degree scan and maps line and character positions back to the original',
  (degrees) => {
    const slope = Math.tan((degrees * Math.PI) / 180)
    const p = scan(255, 30, slope)
    const engine = vi.fn<OcrEngine>().mockReturnValue(recognized)
    const fixed = prepareScanOcr(engine)(encodeRgbaPng(p.rgba, p.width, p.height), page, p)!
    const outHeight = engine.mock.calls[0]![1].heightPt
    expect(outHeight).toBeGreaterThan(p.height)
    const pad = (outHeight - p.height) / 2
    const centerX = (box.x1 + box.x0) / 2
    const expectedY =
      (((box.y1 + box.y0) / 2) * outHeight - pad - (centerX - 0.5) * p.width * slope) / p.height
    const restored = fixed.lines[0]!.box
    expect(Math.abs((restored.y0 + restored.y1) / 2 - expectedY)).toBeLessThan(0.005)
    expect(fixed.lines[0]!.chars![0]!.box).toEqual(restored)
    expect(restored.x0).toBe(box.x0)
  },
)

it('passes a clear level scan directly to the recognizer and retries the original if correction yields nothing', () => {
  const p = scan(255, 0)
  const original = encodeRgbaPng(p.rgba, p.width, p.height)
  const engine = vi.fn<OcrEngine>().mockReturnValue(recognized)
  const ocr = prepareScanOcr(engine)
  ocr(original, page, p)
  expect(engine.mock.calls[0]![0]).toBe(original)
  const faded = scan(155, 121)
  const gray = encodeRgbaPng(faded.rgba, faded.width, faded.height)
  engine.mockClear().mockReturnValueOnce({ lines: [] })
  expect(ocr(gray, page, faded)).toBe(recognized)
  expect(engine.mock.calls[1]![0]).toBe(gray)
})

it.runIf(process.env.TANDEM_TEST_LOCAL_OCR === '1').each([0, 90, 270, 180] as const)(
  'reads faded tilted paper rotated %d degrees into searchable PDF and editable Word with native OCR',
  async (turn) => {
    const dir = await mkdtemp(join(tmpdir(), 'tandem-faded-ocr-'))
    try {
      const m = await ensurePdfium()
      const engine = ensureOcrEngine()
      expect(engine).toBeTruthy()
      const pdf = await PDFDocument.create()
      const page = pdf.addPage([360, 200])
      for (const y of [38, 78, 118, 158])
        page.drawText('Busan travel guide', { x: 42, y, size: 18 })
      const pixels = withPdfDocument(m, await pdf.save(), (doc) => {
        const page = m._FPDF_LoadPage(doc, 0)
        try {
          return renderPagePixels(m, page, 2)!
        } finally {
          m._FPDF_ClosePage(page)
        }
      })
      const { width, height, rgba } = pixels
      const faded = new Uint8Array(rgba.length).fill(255)
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const sy = y - Math.round((x - width / 2) * Math.tan((4 * Math.PI) / 180))
          const gray = sy >= 0 && sy < height ? rgba[(sy * width + x) * 4]! : 255
          const at = (y * width + x) * 4
          faded.fill(142 + Math.round((gray / 255) * 40), at, at + 3)
        }
      }
      const input = join(dir, 'scan.png')
      const corrected = { rgba: faded, width, height }
      const scan = turn ? turnPixels(corrected, turn) : corrected
      await writeFile(input, encodeRgbaPng(scan.rgba, scan.width, scan.height))
      for (const target of ['pdf', 'docx']) {
        const output = join(dir, 'scan OCR.' + target)
        expect(await convertOcrFile(input, target, output, m, engine)).toEqual([])
        const bytes = await readFile(output)
        if (target === 'docx') {
          const zip = await JSZip.loadAsync(bytes)
          const doc = await zip.file('word/document.xml')!.async('string')
          expect(doc.replace(/<[^>]*>/g, '')).toMatch(/Busan travel guide/i)
          const size = doc.match(/<w:pgSz[^>]*w:w="(\d+)"[^>]*w:h="(\d+)"/)
          expect(Number(size?.[1])).toBeGreaterThan(Number(size?.[2]))
        } else {
          const text = withPdfDocument(m, bytes, (doc) => {
            const page = m._FPDF_LoadPage(doc, 0)
            const tp = m._FPDFText_LoadPage(page)
            try {
              const i = Array.from({ length: m._FPDFText_CountChars(tp) }, (_, i) => i).find(
                (i) => m._FPDFText_GetUnicode(tp, i) === 66,
              )!
              const angle =
                (Math.round((m._FPDFText_GetCharAngle(tp, i) * 180) / Math.PI) + 360) % 360
              // PDFium reports clockwise rotation in displayed-page coordinates.
              expect(angle).toBe(turn)
              withAlloc(m, 32, (ptr) => {
                expect(m._FPDFText_GetCharOrigin(tp, i, ptr, ptr + 8)).toBe(1)
                expect(m._FPDFText_GetCharOrigin(tp, i + 1, ptr + 16, ptr + 24)).toBe(1)
                const offset = ptr / 8,
                  view = m.HEAPF64
                const dx = view[offset + 2]! - view[offset]!,
                  dy = view[offset + 3]! - view[offset + 1]!
                if (turn === 90) expect(dy).toBeLessThan(0)
                if (turn === 270) expect(dy).toBeGreaterThan(0)
                if (turn === 180) expect(dx).toBeLessThan(0)
                if (turn === 0) expect(dx).toBeGreaterThan(0)
              })
              return Array.from({ length: m._FPDFText_CountChars(tp) }, (_, i) =>
                String.fromCodePoint(m._FPDFText_GetUnicode(tp, i)),
              ).join('')
            } finally {
              m._FPDFText_ClosePage(tp)
              m._FPDF_ClosePage(page)
            }
          })
          expect(text).toMatch(/Busan/i)
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
)

it('passes skewed thumbnails through and recognizes the original once if preparing the bitmap fails', () => {
  const full = scan(255, 0, Math.tan((4 * Math.PI) / 180))
  const pixels = { ...full, height: 48, rgba: full.rgba.subarray(0, full.width * 48 * 4) }
  const png = encodeRgbaPng(pixels.rgba, pixels.width, pixels.height)
  const engine = vi.fn<OcrEngine>().mockReturnValue(recognized)
  const ocr = prepareScanOcr(engine)
  ocr(png, page, pixels)
  expect(engine.mock.calls[0]![0]).toBe(png)
  const faded = scan(160, 120)
  const original = encodeRgbaPng(faded.rgba, faded.width, faded.height)
  const encoder = vi.spyOn(pngCodec, 'encodeRgbaPng').mockImplementationOnce(() => {
    throw new Error('insufficient working memory')
  })
  try {
    engine.mockClear()
    expect(ocr(original, page, faded)).toBe(recognized)
    expect(encoder).toHaveBeenCalledOnce()
    expect(engine).toHaveBeenCalledExactlyOnceWith(original, page)
  } finally {
    encoder.mockRestore()
  }
})

it('uses an upright candidate only after the original fails and restores its boxes and dimensions', () => {
  const p = scan(255, 0)
  const original = encodeRgbaPng(p.rgba, p.width, p.height)
  const engine = vi.fn<OcrEngine>().mockReturnValueOnce({ lines: [] }).mockReturnValue(recognized)
  const read = prepareScanOcr(engine)(original, page, p)!
  expect(engine).toHaveBeenCalledTimes(2)
  expect(engine.mock.calls[1]![1]).toEqual({ widthPt: page.heightPt, heightPt: page.widthPt })
  expect(read.uprightTurn).toBe(90)
  const mapped = { x0: 1 - box.y1, x1: 1 - box.y0, y0: box.x0, y1: box.x1 }
  expect(read.lines[0]!.box).toEqual(mapped)
  expect(read.lines[0]!.chars![0]!.box).toEqual(mapped)
})
