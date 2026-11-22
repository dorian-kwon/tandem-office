import type { TextInsertInput } from '../../../pdf/src/shared/ipc'
import { pdfToView, viewToPdf, type PageGeom } from '../../../pdf/src/renderer/annotations'
import { applyTextInserts } from '../../../pdf/src/main/text-edit'
import {
  renderPagePixels,
  renderRasterLayerForOcr,
} from '../../../../packages/pdf2docx/src/extract'
import {
  withAlloc,
  withPdfDocument,
  type PdfiumModule,
} from '../../../../packages/pdf2docx/src/extract/pdfium'
import { encodeRgbaPng } from '../../../../packages/pdf2docx/src/extract/png'
import type { OcrEngine } from '../../../../packages/pdf2docx/src/ocr'

function pageGeometry(m: PdfiumModule, page: number, width: number, height: number): PageGeom {
  return withAlloc(m, 16, (p) => {
    const box = (read: PdfiumModule['_FPDFPage_GetMediaBox']) =>
      read(page, p, p + 4, p + 8, p + 12)
        ? Array.from(m.HEAPF32.subarray(p / 4, p / 4 + 4))
        : [0, 0]
    const media = box(m._FPDFPage_GetMediaBox)
    const crop = m._FPDFPage_GetCropBox(page, p, p + 4, p + 8, p + 12)
      ? Array.from(m.HEAPF32.subarray(p / 4, p / 4 + 4))
      : media
    const rot = m._FPDFPage_GetRotation(page) * 90
    return {
      pw: rot % 180 ? height : width,
      ph: rot % 180 ? width : height,
      rot,
      x0: Math.max(media[0]!, crop[0]!),
      y0: Math.max(media[1]!, crop[1]!),
    }
  })
}

const normalize = (s: string) => s.normalize('NFKC').replace(/\s/g, '').toLowerCase()

// Bucket existing glyphs in display coordinates. This keeps a second OCR pass
// from duplicating a hidden text layer, even when the page also contains photos.
function existingText(m: PdfiumModule, page: number, geom: PageGeom) {
  const rows = new Map<number, { x: number; y: number; text: string }[]>()
  const tp = m._FPDFText_LoadPage(page)
  if (!tp) return rows
  try {
    withAlloc(m, 32, (p) => {
      const count = m._FPDFText_CountChars(tp)
      for (let i = 0; i < count; i++) {
        const cp = m._FPDFText_GetUnicode(tp, i)
        if (cp < 33 || cp > 0x10ffff || !m._FPDFText_GetCharBox(tp, i, p, p + 8, p + 16, p + 24))
          continue
        const a = p / 8,
          b = m.HEAPF64
        const [x, y] = pdfToView(geom, (b[a]! + b[a + 1]!) / 2, (b[a + 2]! + b[a + 3]!) / 2)
        const index = Math.floor(y / 24)
        const row = rows.get(index) ?? []
        row.push({ x, y, text: String.fromCodePoint(cp) })
        rows.set(index, row)
      }
    })
  } finally {
    m._FPDFText_ClosePage(tp)
  }
  return rows
}

export async function searchablePdf(
  bytes: Uint8Array,
  m: PdfiumModule,
  ocr: OcrEngine,
  pages?: ReadonlySet<number>,
) {
  const inserts: TextInsertInput[] = []
  const missing: number[] = []
  let searchable = false
  withPdfDocument(m, bytes, (doc) => {
    for (let n = 0; n < m._FPDF_GetPageCount(doc); n++) {
      if (pages && !pages.has(n + 1)) continue
      const page = m._FPDF_LoadPage(doc, n)
      if (!page) throw new Error('Could not read PDF page ' + (n + 1))
      try {
        const w = m._FPDF_GetPageWidthF(page),
          h = m._FPDF_GetPageHeightF(page)
        if (w <= 0 || h <= 0) throw new Error('Invalid PDF page size')
        const geom = pageGeometry(m, page, w, h)
        const existing = existingText(m, page, geom)
        if (existing.size) searchable = true
        // A page containing only native text and vector paths already supports search.
        if (
          existing.size &&
          !Array.from({ length: m._FPDFPage_CountObjects(page) }, (_, i) =>
            m._FPDFPageObj_GetType(m._FPDFPage_GetObject(page, i)),
          ).some((type) => type === 3 || type === 5)
        )
          continue
        const scale = Math.min(2.5, 4096 / Math.max(w, h), Math.sqrt(8_000_000 / (w * h)))
        // On mixed pages show the recognizer only the raster, so an OCR spelling
        // variation can never duplicate or replace a correctly encoded caption.
        const raster = existing.size ? renderRasterLayerForOcr(m, doc, n, scale) : null
        const pixels = raster ?? renderPagePixels(m, page, scale)
        const recognition =
          pixels &&
          ocr(
            raster?.data ?? encodeRgbaPng(pixels.rgba, pixels.width, pixels.height),
            { widthPt: w, heightPt: h },
            pixels,
          )
        if (!recognition) throw new Error('OCR_ENGINE_FAILED')
        let found = false
        for (const { text, box, confidence } of recognition.lines) {
          if (!text.trim() || confidence < 0.25 || box.y1 <= box.y0 || box.x1 <= box.x0) continue
          found = true
          const left = box.x0 * w,
            right = box.x1 * w,
            top = (1 - box.y1) * h,
            bottom = (1 - box.y0) * h
          const native: string[] = []
          for (
            let bucket = Math.floor((top - 2) / 24);
            bucket <= Math.floor((bottom + 2) / 24);
            bucket++
          ) {
            for (const glyph of existing.get(bucket) ?? []) {
              if (
                glyph.x >= left - 2 &&
                glyph.x <= right + 2 &&
                glyph.y >= top - 2 &&
                glyph.y <= bottom + 2
              )
                native.push(glyph.text)
            }
          }
          if (normalize(native.join('')).includes(normalize(text))) continue
          const turn = recognition.uprightTurn ?? 0
          const vertical = turn === 90 || turn === 270
          const height = vertical ? right - left : bottom - top
          const ascent = height * 0.22
          const originX =
            turn === 90
              ? right - ascent
              : turn === 180
                ? right
                : turn === 270
                  ? left + ascent
                  : left
          const originY =
            turn === 90
              ? bottom
              : turn === 180
                ? top + ascent
                : turn === 270
                  ? top
                  : bottom - ascent
          inserts.push({
            pageIndex: n,
            origin: viewToPdf(geom, originX, originY),
            rotate: (geom.rot + turn) % 360,
            text,
            fontSize: Math.max(1, height * 0.82),
            color: [255, 255, 255],
            lineLeading: height * 1.1,
            invisible: true,
            ocrWidth: vertical ? bottom - top : right - left,
          })
        }
        if (!found && !existing.size) missing.push(n + 1)
      } finally {
        m._FPDF_ClosePage(page)
      }
    }
  })
  if (!inserts.length && !searchable) throw new Error('OCR_NO_TEXT')
  if (!inserts.length) return { bytes, missing }
  const result = await applyTextInserts(bytes, inserts)
  if (result.skipped.length) throw new Error('OCR_TEXT_LAYER_FAILED')
  return { bytes: result.bytes, missing }
}
