import type { Lang } from '@genoffice/i18n'
import { pdfPageWarning } from '../shared/conversion-warning'
import type { PageResult } from './pdf2docx-local'

type NoticeKey =
  | 'pdfDocxLocalScannedMsg'
  | 'pdfDocxLocalScannedDetail'
  | 'pdfPptxLocalScannedDetail'
  | 'pdfDocxLocalDegradedMsg'
  | 'pdfDocxLocalDegradedDetail'
  | 'pdfXlsxLocalSkippedMsg'
  | 'pdfXlsxLocalSkippedDetail'
  | 'pdfDocxLocalOcrMsg'

export function pdfExportNotice(
  format: 'docx' | 'pptx' | 'xlsx',
  results: ReadonlyArray<Pick<PageResult, 'page' | 'status'>>,
  lang: Lang,
  t: (key: NoticeKey, params?: { pages: string }) => string,
): { message: string; detail: string } | null {
  if (results.length && results.every((page) => page.status === 'scanned')) {
    const scannedDetail = {
      docx: 'pdfDocxLocalScannedDetail',
      pptx: 'pdfPptxLocalScannedDetail',
      xlsx: 'pdfXlsxLocalSkippedDetail',
    } as const
    return {
      message: t('pdfDocxLocalScannedMsg'),
      detail: t(scannedDetail[format], { pages: results.map((r) => r.page).join(', ') }),
    }
  }

  const ocr = results.filter((page) => page.status === 'ocr').map((page) => page.page)
  const fallback = results
    .filter((page) => page.status === 'scanned' || page.status === 'degraded')
    .map((page) => page.page)
  if (!ocr.length && !fallback.length) return null
  const details: string[] = []
  if (fallback.length)
    details.push(
      t(format === 'xlsx' ? 'pdfXlsxLocalSkippedDetail' : 'pdfDocxLocalDegradedDetail', {
        pages: fallback.join(', '),
      }),
    )
  if (ocr.length) details.push(pdfPageWarning(lang, 'pdf_ocr_pages', ocr))
  const title = format === 'xlsx' ? 'pdfXlsxLocalSkippedMsg' : 'pdfDocxLocalDegradedMsg'
  return {
    message: t(fallback.length ? title : 'pdfDocxLocalOcrMsg'),
    detail: details.join('\n\n'),
  }
}
