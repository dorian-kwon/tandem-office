/**
 * @genoffice/pdf2docx — pure-local PDF → DOCX conversion (P1: single-column
 * text + images, en/zh/ja/ko; P2: lattice tables + RTL logical-order output
 * for ar/he; P3: stream tables, multi-column sections, before_space
 * positioning chain, floating images).
 *
 * Pure-function package: bytes in, bytes out. The caller owns wasm setup —
 * initialize @embedpdf/pdfium (`init({ wasmBinary })` + `_PDFiumExt_Init()`)
 * and pass the module in; nothing here touches Electron or the filesystem.
 *
 * P25 adds a second output format: convertPdfToPptx (rebuild-pptx/) shares
 * the extract→analyze pipeline (pipeline.ts) and rebuilds slides instead.
 */
import { extractIrDocument, isScannedDocument, type ConvertOptions } from './pipeline'
import type { PageResult } from './pipeline'
import { rebuildDocx } from './rebuild'
import { withPdfDocument, renderPageByIndexPng } from './extract'
import type { IrPage } from './ir'

export type { PdfiumModule, PdfLoadErrorCode } from './extract/pdfium'
export { PdfLoadError } from './extract/pdfium'
export * from './ir'
export * from './geometry'
export * from './script'
export * as extract from './extract'
export * as analyze from './analyze'
export * as rebuild from './rebuild'
export type { ConvertOptions, PageResult, IrDocument } from './pipeline'
export { extractIrDocument } from './pipeline'
export type { OcrEngine, OcrLine, OcrChar } from './ocr'
export { convertPdfToPptx, type ConvertPptxResult } from './rebuild-pptx'
export { convertPdfToXlsx, type ConvertXlsxResult } from './rebuild-xlsx'

export interface ConvertResult {
  docx: Uint8Array
  pages: number
  /** human-readable notes about degraded/scanned pages (1-based page numbers) */
  warnings: string[]
  /** per-page outcomes, in page order (P4) */
  pageResults: PageResult[]
  /** most pages are scans → the caller should steer the user to an OCR flow */
  scannedDocument: boolean
}

export async function convertPdfToDocx(
  pdf: Uint8Array,
  opts: ConvertOptions & { keepScanAboveText?: boolean },
): Promise<ConvertResult> {
  const { irPages, warnings, pageResults, furnitureHf } = extractIrDocument(pdf, opts)
  // A full-page scan occupies its own page. Place its editable transcription
  // immediately after it, leaving authored pages and unrecognized scans single.
  const pages =
    opts.keepScanAboveText && irPages.some((p) => p.ocrRecovered)
      ? withPdfDocument(
          opts.pdfium,
          pdf,
          (doc) => {
            const result: IrPage[] = []
            for (const page of irPages) {
              if (page.ocrRecovered) {
                const render = renderPageByIndexPng(
                  opts.pdfium,
                  doc,
                  page.index,
                  opts.renderScale ?? 2,
                )
                if (!render) throw new Error('Could not retain original scan')
                result.push({
                  index: result.length,
                  widthPt: page.widthPt,
                  heightPt: page.heightPt,
                  rotation: page.rotation,
                  scanned: true,
                  degraded: false,
                  hasStructTree: false,
                  blocks: [],
                  render,
                })
              }
              result.push({
                ...page,
                index: result.length,
                flowsFromPrev: page.ocrRecovered ? false : page.flowsFromPrev,
              })
            }
            return result
          },
          opts.password,
        )
      : irPages
  const docx = await rebuildDocx(pages, { furnitureHf })
  return {
    docx,
    pages: irPages.length,
    warnings,
    pageResults,
    scannedDocument: isScannedDocument(pageResults, irPages.length),
  }
}
