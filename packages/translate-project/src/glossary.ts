export type GlossaryEntry = { source: string; target: string; note?: string }

/** Glossaries above this many entries are filtered per paragraph before they go to the model. */
export const DEFAULT_GLOSSARY_LIMIT = 200

const HEADER_SOURCE = '원어'
const HEADER_TARGET = '번역어'

/** Upper bound for any single inflated zip part, a guard against zip bombs. */
const MAX_PART_BYTES = 64 * 1024 * 1024

export function parseGlossary(bytes: Uint8Array, fileName: string): GlossaryEntry[] {
  const ext = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'xlsx') return rowsToEntries(readFirstSheet(bytes))
  if (ext === 'csv') return rowsToEntries(parseDelimited(decodeText(bytes), ','))
  if (ext === 'txt') return rowsToEntries(parseDelimited(decodeText(bytes), '\t'))
  throw new Error(`Unsupported glossary file type: ${fileName}`)
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

function rowsToEntries(rows: string[][]): GlossaryEntry[] {
  const entries: GlossaryEntry[] = []
  rows.forEach((row, index) => {
    const source = (row[0] ?? '').trim()
    const target = (row[1] ?? '').trim()
    const note = (row[2] ?? '').trim()
    if (index === 0 && source === HEADER_SOURCE && target === HEADER_TARGET) return
    if (source === '') return
    entries.push(note === '' ? { source, target } : { source, target, note })
  })
  return entries
}

/** Strict UTF-8 first; anything that is not valid UTF-8 is read as CP949 (euc-kr). */
function decodeText(bytes: Uint8Array): string {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    text = new TextDecoder('euc-kr').decode(bytes)
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
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
  if (workbook === undefined) throw new Error('Not a valid xlsx file: missing workbook')

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
  if (sheet === undefined) throw new Error('Not a valid xlsx file: missing first sheet')

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
      if (col < 0 || col > 15) {
        next += 1
        continue
      }
      next = col + 1
      const type = attr(attrs, 't')
      const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1]
      let value = ''
      if (type === 's') value = shared[Number(raw)] ?? ''
      else if (type === 'inlineStr') value = runText(body)
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
  if (eocd < 0) throw new Error('Not a valid xlsx file: zip directory not found')
  const count = view.getUint16(eocd + 10, true)
  let pos = view.getUint32(eocd + 16, true)
  const parts = new Map<string, () => Uint8Array>()
  for (let n = 0; n < count; n++) {
    if (pos + 46 > bytes.length || view.getUint32(pos, true) !== 0x02014b50) {
      throw new Error('Not a valid xlsx file: corrupt zip directory')
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
      if (size > MAX_PART_BYTES) throw new Error('xlsx part is too large')
      const dataStart =
        localOffset +
        30 +
        view.getUint16(localOffset + 26, true) +
        view.getUint16(localOffset + 28, true)
      const data = bytes.subarray(dataStart, dataStart + compressedSize)
      if (method === 0) return data
      if (method === 8) return inflateRaw(data, size)
      throw new Error(`Unsupported zip compression method ${method}`)
    })
  }
  return parts
}

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
]
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
]
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
]
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
]
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

type Huffman = { counts: Uint16Array; symbols: Uint16Array }

function buildHuffman(lengths: ArrayLike<number>, n: number): Huffman {
  const counts = new Uint16Array(16)
  for (let i = 0; i < n; i++) counts[lengths[i]]++
  const offsets = new Uint16Array(16)
  for (let i = 1; i < 15; i++) offsets[i + 1] = offsets[i] + counts[i]
  const symbols = new Uint16Array(n)
  for (let i = 0; i < n; i++) if (lengths[i] !== 0) symbols[offsets[lengths[i]]++] = i
  return { counts, symbols }
}

/** Raw DEFLATE (RFC 1951) decoder. `expected` is the size the zip directory declares. */
function inflateRaw(input: Uint8Array, expected: number): Uint8Array {
  let out = new Uint8Array(Math.max(expected, 16))
  let outLen = 0
  let inPos = 0
  let bitBuf = 0
  let bitCount = 0

  const bits = (need: number): number => {
    while (bitCount < need) {
      if (inPos >= input.length) throw new Error('Corrupt xlsx: unexpected end of data')
      bitBuf |= input[inPos++] << bitCount
      bitCount += 8
    }
    const value = bitBuf & ((1 << need) - 1)
    bitBuf >>>= need
    bitCount -= need
    return value
  }
  const decode = (h: Huffman): number => {
    let code = 0
    let first = 0
    let index = 0
    for (let len = 1; len <= 15; len++) {
      code |= bits(1)
      const count = h.counts[len]
      if (code - count < first) return h.symbols[index + (code - first)]
      index += count
      first += count
      first <<= 1
      code <<= 1
    }
    throw new Error('Corrupt xlsx: bad huffman code')
  }
  const push = (byte: number): void => {
    if (outLen >= MAX_PART_BYTES) throw new Error('xlsx part is too large')
    if (outLen === out.length) {
      const grown = new Uint8Array(Math.min(out.length * 2, MAX_PART_BYTES))
      grown.set(out)
      out = grown
    }
    out[outLen++] = byte
  }

  const fixedLengths = new Uint8Array(288)
  fixedLengths.fill(8, 0, 144)
  fixedLengths.fill(9, 144, 256)
  fixedLengths.fill(7, 256, 280)
  fixedLengths.fill(8, 280, 288)
  const fixedLit = buildHuffman(fixedLengths, 288)
  const fixedDist = buildHuffman(new Uint8Array(30).fill(5), 30)

  let last = false
  while (!last) {
    last = bits(1) === 1
    const type = bits(2)
    if (type === 0) {
      bitBuf = 0
      bitCount = 0
      if (inPos + 4 > input.length) throw new Error('Corrupt xlsx: unexpected end of data')
      const len = input[inPos] | (input[inPos + 1] << 8)
      inPos += 4
      if (inPos + len > input.length) throw new Error('Corrupt xlsx: unexpected end of data')
      for (let i = 0; i < len; i++) push(input[inPos++])
      continue
    }
    if (type === 3) throw new Error('Corrupt xlsx: bad block type')
    let lit = fixedLit
    let dist = fixedDist
    if (type === 2) {
      const hlit = bits(5) + 257
      const hdist = bits(5) + 1
      const hclen = bits(4) + 4
      const clLengths = new Uint8Array(19)
      for (let i = 0; i < hclen; i++) clLengths[CODE_LENGTH_ORDER[i]] = bits(3)
      const clHuffman = buildHuffman(clLengths, 19)
      const lengths = new Uint8Array(hlit + hdist)
      let i = 0
      while (i < hlit + hdist) {
        const sym = decode(clHuffman)
        if (sym < 16) lengths[i++] = sym
        else {
          let repeat: number
          let value = 0
          if (sym === 16) {
            if (i === 0) throw new Error('Corrupt xlsx: bad code lengths')
            value = lengths[i - 1]
            repeat = 3 + bits(2)
          } else if (sym === 17) repeat = 3 + bits(3)
          else repeat = 11 + bits(7)
          if (i + repeat > hlit + hdist) throw new Error('Corrupt xlsx: bad code lengths')
          while (repeat-- > 0) lengths[i++] = value
        }
      }
      lit = buildHuffman(lengths.subarray(0, hlit), hlit)
      dist = buildHuffman(lengths.subarray(hlit), hdist)
    }
    for (;;) {
      const sym = decode(lit)
      if (sym < 256) push(sym)
      else if (sym === 256) break
      else {
        const li = sym - 257
        if (li >= 29) throw new Error('Corrupt xlsx: bad length symbol')
        const length = LENGTH_BASE[li] + bits(LENGTH_EXTRA[li])
        const di = decode(dist)
        if (di >= 30) throw new Error('Corrupt xlsx: bad distance symbol')
        const distance = DIST_BASE[di] + bits(DIST_EXTRA[di])
        if (distance > outLen) throw new Error('Corrupt xlsx: bad distance')
        for (let k = 0; k < length; k++) push(out[outLen - distance])
      }
    }
  }
  return out.subarray(0, outLen)
}
