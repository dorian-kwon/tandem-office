import { describe, expect, it } from 'vitest'
import { pdfExportNotice } from '../src/main/pdf-export-notice'

const text = (key: string, params?: { pages: string }) => (params ? `${key}: ${params.pages}` : key)

describe('PDF editor export notice', () => {
  it.each(['docx', 'pptx', 'xlsx'] as const)(
    'reports OCR and fallback pages separately in %s',
    (format) => {
      const result = pdfExportNotice(
        format,
        [
          { page: 1, status: 'ok' },
          { page: 2, status: 'scanned' },
          { page: 3, status: 'ocr' },
          { page: 4, status: 'scanned' },
          { page: 5, status: 'scanned' },
        ],
        'en',
        text,
      )
      const fallback =
        format === 'xlsx' ? 'pdfXlsxLocalSkippedDetail' : 'pdfDocxLocalDegradedDetail'
      expect(result?.detail).toBe(
        `${fallback}: 2, 4, 5\n\nLocal OCR recognized text in images. Please proofread the listed pages (3).`,
      )
      expect(pdfExportNotice(format, [{ page: 1, status: 'ocr' }], 'en', text)?.message).toBe(
        'pdfDocxLocalOcrMsg',
      )
      expect(pdfExportNotice(format, [{ page: 1, status: 'ok' }], 'en', text)).toBeNull()
      expect(pdfExportNotice(format, [{ page: 1, status: 'scanned' }], 'en', text)?.message).toBe(
        'pdfDocxLocalScannedMsg',
      )
    },
  )
})
