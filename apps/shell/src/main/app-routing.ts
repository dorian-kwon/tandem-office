import type { DocumentTabKind } from '../shared/tabs-api'

/**
 * The extensions each editor tab opens, lower case without the dot. The
 * regular expressions below are built from this table, so the open route, the
 * open-dialog filter, the rename gate and the translation tool's source types
 * (`EDITABLE_SOURCE_EXTENSIONS` in @genoffice/translate-project, held equal by
 * tests/translate-source-types.test.ts) cannot drift.
 */
export const ROUTED_EXTENSIONS = {
  docx: ['docx'],
  // OpenDocument text opens in the Word tab too (apps/docs docFormatOfPath picks the format)
  odt: ['odt'],
  xlsx: ['xlsx', 'xlsm', 'xls', 'csv', 'tsv'],
  pptx: ['pptx'],
  pdf: ['pdf'],
  html: ['html', 'htm'],
  mindmap: ['xmind'],
  hwp: ['hwp', 'hwpx'],
  epub: ['epub'],
  text: ['md', 'markdown', 'txt', 'json'],
} as const satisfies Record<string, readonly string[]>

const extensionRe = (exts: readonly string[]): RegExp => new RegExp(`\\.(${exts.join('|')})$`, 'i')

// shared by the open route, the open-dialog filter and the rename gate so they cannot drift
const DOCX_RE = extensionRe(ROUTED_EXTENSIONS.docx)
const ODT_RE = extensionRe(ROUTED_EXTENSIONS.odt)
const XLSX_RE = extensionRe(ROUTED_EXTENSIONS.xlsx)
const PPTX_RE = extensionRe(ROUTED_EXTENSIONS.pptx)
const PDF_RE = extensionRe(ROUTED_EXTENSIONS.pdf)
const HTML_RE = extensionRe(ROUTED_EXTENSIONS.html)
const MINDMAP_RE = extensionRe(ROUTED_EXTENSIONS.mindmap)
const HWP_RE = extensionRe(ROUTED_EXTENSIONS.hwp)
const EPUB_RE = extensionRe(ROUTED_EXTENSIONS.epub)

const TEXT_RE = extensionRe(ROUTED_EXTENSIONS.text)

export { DOCX_RE, ODT_RE, XLSX_RE, PPTX_RE, PDF_RE, HTML_RE, MINDMAP_RE, HWP_RE, EPUB_RE, TEXT_RE }

export function appForPath(path: string): DocumentTabKind | undefined {
  if (DOCX_RE.test(path) || ODT_RE.test(path)) return 'docs'
  if (XLSX_RE.test(path)) return 'sheets'
  if (PPTX_RE.test(path)) return 'slides'
  if (PDF_RE.test(path)) return 'pdf'
  if (TEXT_RE.test(path)) return 'markdown'
  if (HTML_RE.test(path)) return 'html'
  if (MINDMAP_RE.test(path)) return 'mindmap'
  if (HWP_RE.test(path)) return 'hwp'
  if (EPUB_RE.test(path)) return 'epub'
  return undefined
}

/** A legal name in an extension no app routes to would turn an openable file into an unopenable one. */
export function renameStaysInApp(from: string, newName: string): boolean {
  const current = appForPath(from)
  if (!current) return true
  // .docx and .odt share the Word tab but not the bytes: renaming one into the
  // other leaves a file the Word editor reads as corrupt
  if (current === 'docs' && ODT_RE.test(from) !== ODT_RE.test(newName)) return false
  return appForPath(newName) === current
}
