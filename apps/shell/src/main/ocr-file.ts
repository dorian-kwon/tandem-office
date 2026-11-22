import { readFile, writeFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { optimizeConvertedImages } from '../../../../packages/cli/src/formats/optimize-converted-images'
import { imagesToPdfBytes } from '../../../pdf/src/main/images-to-pdf'
import {
  convertPdfToDocx,
  type OcrEngine,
  type PdfiumModule,
} from '../../../../packages/pdf2docx/src'
import { withPdfDocument } from '../../../../packages/pdf2docx/src/extract'
import { ocrPageSelection } from './ocr-page-range'
import { prepareScanOcr } from './ocr-scan-preparation'
import { ocrTargets } from './ocr-targets'
import { searchablePdf } from './ocr-searchable'

export async function convertOcrFile(
  input: string,
  format: string,
  output: string,
  pdfium: PdfiumModule,
  ocr: OcrEngine | null,
  pageRange?: string,
): Promise<number[]> {
  if (!ocr) throw new Error('OCR_UNAVAILABLE')
  ocr = prepareScanOcr(ocr)
  if (!ocrTargets(input).includes(format)) throw new Error('Unsupported OCR format')
  const original = await readFile(input)
  const pdf =
    extname(input).toLowerCase() === '.pdf'
      ? original
      : await imagesToPdfBytes([original], { paper: null, marginPt: 0 })
  const pages = pageRange?.trim()
    ? withPdfDocument(pdfium, pdf, (doc) =>
        ocrPageSelection(pageRange, pdfium._FPDF_GetPageCount(doc)),
      )
    : undefined
  if (format === 'pdf') {
    const result = await searchablePdf(pdf, pdfium, ocr, pages)
    await writeFile(output, result.bytes)
    if (result.bytes !== original) await optimizeConvertedImages(output, format)
    return result.missing
  }
  const result = await convertPdfToDocx(pdf, { pdfium, ocr, ocrPages: pages })
  const requested = result.pageResults.filter((p) => !pages || pages.has(p.page))
  const missing = requested
    .filter((p) => p.status === 'scanned' || p.status === 'degraded')
    .map((p) => p.page)
  if (!requested.length || missing.length === requested.length) throw new Error('OCR_NO_TEXT')
  await writeFile(output, result.docx)
  await optimizeConvertedImages(output, format)
  return missing
}
