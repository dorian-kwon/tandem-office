/**
 * Translation of the sources no editor can change (spec 6.4): a PDF with a
 * text layer, a scanned PDF and an image.
 */

/** a page with fewer characters than this in its text layer counts as a picture of a page */
export const SCAN_MIN_TEXT_CHARS = 20

/** share of such pages from which the whole PDF is read as a scan */
export const SCAN_PAGE_SHARE = 0.5

/**
 * "Most pages have no text layer": at least SCAN_PAGE_SHARE (half) of the
 * pages hold fewer than SCAN_MIN_TEXT_CHARS characters. Half, not more than
 * half, because the text engine leaves a scanned page untranslated: a PDF
 * that is half scans is better read by OCR. No pages: not a scan.
 */
export function isMostlyScanned(counts: readonly number[]): boolean {
  if (counts.length === 0) return false
  const pictures = counts.filter((n) => n < SCAN_MIN_TEXT_CHARS).length
  return pictures / counts.length >= SCAN_PAGE_SHARE
}

export interface ScanDetectDeps {
  /** characters in each page's text layer (a structure job in the app) */
  pageTextCounts(pdfPath: string): Promise<number[]>
}

/** true when most pages of the PDF have no text layer (isMostlyScanned) */
export async function detectScan(pdfPath: string, deps: ScanDetectDeps): Promise<boolean> {
  return isMostlyScanned(await deps.pageTextCounts(pdfPath))
}
