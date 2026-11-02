import { inflateRawSync } from 'node:zlib'

export type GlossaryEntry = { source: string; target: string; note?: string }

/** A glossary file that cannot be read: an unsupported type, or a damaged xlsx. */
export class GlossaryFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GlossaryFormatError'
  }
}

/** Glossaries above this many entries are filtered per paragraph before they go to the model. */
export const DEFAULT_GLOSSARY_LIMIT = 200

const HEADER_SOURCE_ALIASES = ['원어', '용어', '원문', '출발어', 'source', 'term', 'src']
const HEADER_TARGET_ALIASES = ['번역어', '번역', '역어', '도착어', 'target', 'translation', 'tgt']

/** Upper bound for any single inflated zip part, a guard against zip bombs. */
const MAX_PART_BYTES = 64 * 1024 * 1024

/** Every failure to read the file leaves as a GlossaryFormatError. */
export function parseGlossary(bytes: Uint8Array, fileName: string): GlossaryEntry[] {
  const ext = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'xlsx') {
    try {
      return rowsToEntries(readFirstSheet(bytes))
    } catch (e) {
      if (e instanceof GlossaryFormatError) throw e
      // zlib and DataView failures on a damaged file
      throw new GlossaryFormatError(`Corrupt xlsx: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (ext === 'csv') return rowsToEntries(parseDelimited(decodeText(bytes), ','))
  if (ext === 'txt') return rowsToEntries(parseDelimited(decodeText(bytes), '\t'))
  throw new GlossaryFormatError(`Unsupported glossary file type: ${fileName}`)
}

export function selectGlossary(
  entries: GlossaryEntry[],
  paragraph: string,
  limit = DEFAULT_GLOSSARY_LIMIT,
): GlossaryEntry[] {
  if (entries.length <= limit) return entries
  const haystack = paragraph.toLowerCase()
  return entries.filter((entry) => haystack.includes(entry.source.toLowerCase()))
}

function isHeader(source: string, target: string): boolean {
  return (
    HEADER_SOURCE_ALIASES.includes(source.toLowerCase()) &&
    HEADER_TARGET_ALIASES.includes(target.toLowerCase())
  )
}

function rowsToEntries(rows: string[][]): GlossaryEntry[] {
  const entries: GlossaryEntry[] = []
  rows.forEach((row, index) => {
    const source = (row[0] ?? '').trim()
    const target = (row[1] ?? '').trim()
    const note = (row[2] ?? '').trim()
    if (index === 0 && isHeader(source, target)) return
    if (source === '') return
    entries.push(note === '' ? { source, target } : { source, target, note })
  })
  return entries
}

/**
 * UTF-16 by its byte-order mark (FF FE little endian, FE FF big endian: Excel's
 * "Unicode Text" export), or without one by its zero bytes; then strict UTF-8;
 * anything that is not valid UTF-8 is read as CP949 (euc-kr).
 */
function decodeText(bytes: Uint8Array): string {
  let text: string
  const utf16 = utf16Endian(bytes)
  if (utf16) {
    text = new TextDecoder(utf16).decode(bytes)
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      text = new TextDecoder('euc-kr').decode(bytes)
    }
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * The UTF-16 byte order of `bytes`, or null. Without a byte-order mark only a
 * cheap, safe guess: UTF-8 and CP949 text never holds a zero byte, while
 * UTF-16 text with any ASCII character (a tab, comma or line break, which every
 * glossary row has) does, mostly on one side of each pair. A file whose zero
 * bytes are not clearly on one side is not taken for UTF-16.
 */
function utf16Endian(bytes: Uint8Array): 'utf-16le' | 'utf-16be' | null {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  if (bytes.length < 2 || bytes.length % 2 !== 0) return null
  let evenZeros = 0
  let oddZeros = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0) continue
    if (i % 2 === 0) evenZeros++
    else oddZeros++
  }
  // a character such as U+AC00 has a zero low byte, so the other side may hold a few
  if (oddZeros > 0 && evenZeros * 4 < oddZeros) return 'utf-16le'
  if (evenZeros > 0 && oddZeros * 4 < evenZeros) return 'utf-16be'
  return null
}

function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const endRow = (): void => {
    row.push(field)
    field = ''
    if (row.some((cell) => cell.trim() !== '')) rows.push(row)
    row = []
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
    } else if (ch === '"' && field === '' && delimiter === ',') quoted = true
    else if (ch === delimiter) {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      endRow()
    } else field += ch
  }
  endRow()
  return rows
}

// ---------------------------------------------------------------------------
// Minimal xlsx reader: zip central directory + inflate + sharedStrings + first sheet.
// Pure and synchronous so the package stays free of runtime dependencies.
// ---------------------------------------------------------------------------

function readFirstSheet(bytes: Uint8Array): string[][] {
  const parts = readZip(bytes)
  const text = (path: string): string | undefined => {
    const part = parts.get(path)
    return part === undefined ? undefined : new TextDecoder('utf-8').decode(part())
  }
  const workbook = text('xl/workbook.xml')
  if (workbook === undefined)
    throw new GlossaryFormatError('Not a valid xlsx file: missing workbook')

  let sheetPath = 'xl/worksheets/sheet1.xml'
  const firstSheet = /<(?:\w+:)?sheet\b[^>]*>/.exec(workbook)
  const relId = firstSheet ? /\br:id="([^"]*)"/.exec(firstSheet[0])?.[1] : undefined
  const rels = text('xl/_rels/workbook.xml.rels')
  if (relId !== undefined && rels !== undefined) {
    for (const rel of rels.match(/<Relationship\b[^>]*>/g) ?? []) {
      if (attr(rel, 'Id') !== relId) continue
      const target = attr(rel, 'Target')
      if (target !== undefined) {
        sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target}`
      }
    }
  }
  const sheet = text(sheetPath)
  if (sheet === undefined)
    throw new GlossaryFormatError('Not a valid xlsx file: missing first sheet')

  const shared = parseSharedStrings(text('xl/sharedStrings.xml') ?? '')
  return parseSheet(sheet, shared)
}

function attr(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(tag)
  return match ? decodeXml(match[1]) : undefined
}

function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, code: string) => {
    const lower = code.toLowerCase()
    if (lower === 'amp') return '&'
    if (lower === 'lt') return '<'
    if (lower === 'gt') return '>'
    if (lower === 'quot') return '"'
    if (lower === 'apos') return "'"
    const point = lower.startsWith('#x')
      ? parseInt(lower.slice(2), 16)
      : parseInt(lower.slice(1), 10)
    return Number.isFinite(point) && point <= 0x10ffff ? String.fromCodePoint(point) : whole
  })
}

/** Concatenate the <t> runs of a fragment, skipping phonetic hints (<rPh>). */
function runText(fragment: string): string {
  const stripped = fragment.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, '')
  let out = ''
  for (const match of stripped.matchAll(/<(?:\w+:)?t\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?t>)/g)) {
    out += decodeXml(match[1] ?? '')
  }
  return out
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = []
  for (const match of xml.matchAll(/<(?:\w+:)?si\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?si>)/g)) {
    out.push(runText(match[1] ?? ''))
  }
  return out
}

function columnIndex(ref: string): number {
  let index = 0
  for (const ch of ref.toUpperCase()) {
    if (ch < 'A' || ch > 'Z') break
    index = index * 26 + (ch.charCodeAt(0) - 64)
  }
  return index - 1
}

function parseSheet(xml: string, shared: string[]): string[][] {
  const rows: string[][] = []
  for (const rowMatch of xml.matchAll(
    /<(?:\w+:)?row\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g,
  )) {
    const cells: string[] = []
    let next = 0
    for (const cell of (rowMatch[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1] ?? ''
      const body = cell[2] ?? ''
      const ref = attr(attrs, 'r')
      const col = ref === undefined ? next : columnIndex(ref)
      // Only columns A to C (source, target, note) are read; anything further right is ignored.
      if (col < 0 || col > 2) {
        next += 1
        continue
      }
      next = col + 1
      const type = attr(attrs, 't')
      const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1]
      let value = ''
      if (type === 's') {
        const text = shared[Number(raw)]
        if (text === undefined)
          throw new GlossaryFormatError(`Corrupt xlsx: shared string ${raw} is out of range`)
        value = text
      } else if (type === 'inlineStr') value = runText(body)
      else if (raw !== undefined) value = decodeXml(raw)
      while (cells.length < col) cells.push('')
      cells[col] = value
    }
    if (cells.some((cell) => cell.trim() !== '')) rows.push(cells)
  }
  return rows
}

function readZip(bytes: Uint8Array): Map<string, () => Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new GlossaryFormatError('Not a valid xlsx file: zip directory not found')
  const count = view.getUint16(eocd + 10, true)
  let pos = view.getUint32(eocd + 16, true)
  const parts = new Map<string, () => Uint8Array>()
  for (let n = 0; n < count; n++) {
    if (pos + 46 > bytes.length || view.getUint32(pos, true) !== 0x02014b50) {
      throw new GlossaryFormatError('Not a valid xlsx file: corrupt zip directory')
    }
    const method = view.getUint16(pos + 10, true)
    const compressedSize = view.getUint32(pos + 20, true)
    const size = view.getUint32(pos + 24, true)
    const nameLength = view.getUint16(pos + 28, true)
    const extraLength = view.getUint16(pos + 30, true)
    const commentLength = view.getUint16(pos + 32, true)
    const localOffset = view.getUint32(pos + 42, true)
    const name = new TextDecoder('utf-8').decode(bytes.subarray(pos + 46, pos + 46 + nameLength))
    pos += 46 + nameLength + extraLength + commentLength
    parts.set(name, () => {
      if (size > MAX_PART_BYTES) throw new GlossaryFormatError('xlsx part is too large')
      const dataStart =
        localOffset +
        30 +
        view.getUint16(localOffset + 26, true) +
        view.getUint16(localOffset + 28, true)
      const data = bytes.subarray(dataStart, dataStart + compressedSize)
      if (method === 0) return data
      if (method === 8) {
        // maxOutputLength is the zip-bomb guard: inflate aborts past the cap
        return inflateRawSync(data, { maxOutputLength: MAX_PART_BYTES })
      }
      throw new GlossaryFormatError(`Unsupported zip compression method ${method}`)
    })
  }
  return parts
}
