import { extname } from 'node:path'

/**
 * Turns a reference file into markdown text for the keyword index
 * (reference-index.ts). The reading itself is injected: the shell passes
 * `parseFileToText` of packages/file-parse, the same path every attachment
 * and cross-file read takes (redaction included). This package has no parser
 * and never reads a file here; it only decides what the extracted text means.
 *
 * No OCR and no local model: an image, or a PDF without a text layer, is
 * reported as `needs-ocr` so the person can run the app's OCR on it.
 */

/** what the injected reader returns (the shape of file-parse's ParsedFile) */
export interface ReferenceExtractResult {
  ok: boolean
  kind: 'text' | 'image' | 'unsupported'
  text?: string
  mime?: string
  error?: string
}

export type ReferenceExtract = (path: string) => Promise<ReferenceExtractResult>

export type ReferenceConversion =
  { ok: true; md: string } | { ok: false; reason: 'needs-ocr' | 'unsupported' | 'failed' }

/** the formats converted: text-bearing PDFs and the document types of the brief */
export const REFERENCE_TEXT_EXTENSIONS: readonly string[] = [
  'pdf',
  'docx',
  'hwp',
  'hwpx',
  'pptx',
  'xlsx',
  'epub',
  'html',
  'htm',
  'md',
  'markdown',
  'txt',
]

/** picture files: only OCR can read them */
export const REFERENCE_IMAGE_EXTENSIONS: readonly string[] = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'tif',
  'tiff',
]

/** a PDF with fewer letters or digits than this has no usable text layer (page numbers at most) */
export const PDF_TEXT_MIN_CHARS = 20

function letterCount(text: string): number {
  return (text.match(/[\p{L}\p{N}]/gu) ?? []).length
}

export async function convertReferenceToMarkdown(
  file: string,
  extract: ReferenceExtract,
): Promise<ReferenceConversion> {
  const ext = extname(file).slice(1).toLowerCase()
  if (REFERENCE_IMAGE_EXTENSIONS.includes(ext)) return { ok: false, reason: 'needs-ocr' }
  if (!REFERENCE_TEXT_EXTENSIONS.includes(ext)) return { ok: false, reason: 'unsupported' }
  let parsed: ReferenceExtractResult
  try {
    parsed = await extract(file)
  } catch {
    return { ok: false, reason: 'failed' }
  }
  if (parsed.kind === 'image') return { ok: false, reason: 'needs-ocr' }
  if (!parsed.ok || parsed.kind !== 'text' || typeof parsed.text !== 'string')
    return { ok: false, reason: 'failed' }
  const raw = ext === 'html' || ext === 'htm' ? htmlToMarkdown(parsed.text) : parsed.text
  // one line ending, no trailing blanks on a line: the chunker then scans each line once
  const md = raw
    .split(/\r\n?|\n/)
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()
  if (ext === 'pdf' && letterCount(md) < PDF_TEXT_MIN_CHARS)
    return { ok: false, reason: 'needs-ocr' }
  if (md === '') return { ok: false, reason: 'failed' }
  return { ok: true, md }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code =
        name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1))
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? whole
  })
}

/**
 * HTML source (already redacted by the reader) as plain markdown: headings
 * become `#` lines, list items `- ` lines, block ends blank lines; scripts,
 * styles, comments and every other tag are dropped. Good enough for keyword
 * search, not a faithful conversion.
 */
export function htmlToMarkdown(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, level: string) => `\n\n${'#'.repeat(Number(level))} `)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|ul|ol|table|tr|section|article|blockquote|pre)\s*>/gi, '\n\n')
    .replace(/<\/(li|td|th)\s*>/gi, (_m, tag: string) => (tag.toLowerCase() === 'li' ? '' : ' '))
    .replace(/<[^>]*>/g, '')
  text = decodeEntities(text)
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/(^|\n)(- [^\n]*)\n\n(?=- )/g, '$1$2\n')
    .trim()
}
