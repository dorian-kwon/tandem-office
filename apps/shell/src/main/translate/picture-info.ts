import type { Stats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { extname, join, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import type { SourceEntry } from '@genoffice/translate-project'
import type { TranslatePictureInfo } from '../../shared/translate-api'

/**
 * Pictures embedded in a translation project's sources and references
 * (`translate:picture-info`). Text inside a picture is not part of the
 * document text, so it is never translated; the detail screen says so next
 * to the file and points at the OCR route that exists (a scan PDF or an
 * image added as a source).
 *
 * How pictures are counted (read-only, nothing is written):
 * - Only zip-based formats, and only pictures the document's content places
 *   (`CONTENT_RULES`): a docx counts the image relationships of its body,
 *   headers, footers, footnotes and endnotes; a pptx those of its slides and
 *   notes pages (never slide masters or layouts, which carry template
 *   backgrounds and logos); an xlsx those of its drawings; an ODF file the
 *   `Pictures/` links in content.xml (not styles.xml); an HWPX the binary
 *   items its sections refer to. An EPUB counts picture files anywhere in
 *   the book. Media files nothing in the content refers to do not count.
 * - The preview picture of an embedded object (an equation or another OLE
 *   object: `w:object` in a docx, `p:oleObj` in a pptx) does not count.
 * - A picture is a target with a raster or Office metafile extension
 *   (`PICTURE_EXTENSIONS`; SVG is left out because Office stores a PNG copy
 *   beside each SVG) of at least `PICTURE_MIN_BYTES` uncompressed bytes, so
 *   bullets, lines and other tiny decorations do not count. The same media
 *   file used on several pages counts once.
 * - Not detected at all: text PDFs, the old binary formats (doc, xls, ppt,
 *   hwp), and text drawn as shapes, WordArt, SmartArt or charts (none of
 *   them is a picture file). PDFs, images, binary files and plain text give
 *   `null`: images and scans already go through the OCR kind logic.
 *
 * Safety: a file larger than `maxFileBytes`, a central directory larger than
 * `maxCentralBytes` or with more than `maxEntries` entries, a content part
 * that would inflate past `maxPartBytes`, more than `maxTextBytes` of
 * content read in all, zip64, encryption and any structural damage give
 * `null` (unknown, shown as no notice); nothing here throws. Inflation is
 * capped by output length, so a forged size cannot cost more than the cap.
 * A file or folder that is a link, or resolves outside the project folder,
 * is never opened.
 *
 * Answers are kept in memory per file, recorded hash (sources), size and
 * change time; nothing is written to the project folder.
 */

export const PICTURE_MIN_BYTES = 2048

export const PICTURE_EXTENSIONS: readonly string[] = [
  'png',
  'jpg',
  'jpeg',
  'jpe',
  'gif',
  'bmp',
  'tif',
  'tiff',
  'webp',
  'emf',
  'wmf',
]

export interface PictureLimits {
  /** files above this size are not looked at */
  maxFileBytes: number
  /** central directories above this size are not read */
  maxCentralBytes: number
  /** archives with more entries are not counted */
  maxEntries: number
  /** one content part (xml, relationships) inflated at most to this many bytes */
  maxPartBytes: number
  /** all content parts of one file together at most this many inflated bytes */
  maxTextBytes: number
}

export const DEFAULT_PICTURE_LIMITS: PictureLimits = {
  maxFileBytes: 1024 * 1024 * 1024,
  maxCentralBytes: 16 * 1024 * 1024,
  maxEntries: 20_000,
  maxPartBytes: 32 * 1024 * 1024,
  maxTextBytes: 128 * 1024 * 1024,
}

type Family = 'docx' | 'pptx' | 'xlsx' | 'odf' | 'hwpx' | 'epub'

const FAMILIES: Record<string, Family> = {
  docx: 'docx',
  docm: 'docx',
  dotx: 'docx',
  pptx: 'pptx',
  pptm: 'pptx',
  ppsx: 'pptx',
  potx: 'pptx',
  xlsx: 'xlsx',
  xlsm: 'xlsx',
  odt: 'odf',
  ods: 'odf',
  odp: 'odf',
  hwpx: 'hwpx',
  epub: 'epub',
}

/** which counting rule a file name gets; null: not covered */
export function pictureFamilyOf(fileName: string): Family | null {
  const ext = extname(fileName).slice(1).toLowerCase()
  return Object.prototype.hasOwnProperty.call(FAMILIES, ext) ? FAMILIES[ext]! : null
}

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const EOCD_MIN = 22
/** the end record plus the longest comment a zip may carry */
const TAIL_BYTES = EOCD_MIN + 0xffff

interface ZipEntry {
  name: string
  method: number
  flags: number
  csize: number
  usize: number
  local: number
}

/** random access to the archive's bytes */
interface ZipBytes {
  size: number
  read(offset: number, length: number): Promise<Uint8Array>
}

function u16(b: Uint8Array, at: number): number {
  return b[at]! | (b[at + 1]! << 8)
}

function u32(b: Uint8Array, at: number): number {
  return (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0
}

class Unknown extends Error {}

/** the archive's entries by name, from the central directory alone */
async function readEntries(zip: ZipBytes, lim: PictureLimits): Promise<Map<string, ZipEntry>> {
  const tailLen = Math.min(zip.size, TAIL_BYTES)
  const tail = await zip.read(zip.size - tailLen, tailLen)
  let at = tail.length - EOCD_MIN
  while (at >= 0 && u32(tail, at) !== EOCD_SIG) at -= 1
  if (at < 0) throw new Unknown()
  const count = u16(tail, at + 10)
  const size = u32(tail, at + 12)
  const offset = u32(tail, at + 16)
  // zip64 markers: not handled, so unknown
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw new Unknown()
  if (count > lim.maxEntries || size > lim.maxCentralBytes) throw new Unknown()
  if (offset + size > zip.size) throw new Unknown()
  const cd = await zip.read(offset, size)
  const decoder = new TextDecoder('utf-8')
  const entries = new Map<string, ZipEntry>()
  let p = 0
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > cd.length || u32(cd, p) !== CENTRAL_SIG) throw new Unknown()
    const nameLen = u16(cd, p + 28)
    const next = p + 46 + nameLen + u16(cd, p + 30) + u16(cd, p + 32)
    if (next > cd.length) throw new Unknown()
    const name = decoder.decode(cd.subarray(p + 46, p + 46 + nameLen))
    entries.set(name, {
      name,
      flags: u16(cd, p + 8),
      method: u16(cd, p + 10),
      csize: u32(cd, p + 20),
      usize: u32(cd, p + 24),
      local: u32(cd, p + 42),
    })
    p = next
  }
  return entries
}

/** reads content parts as text under the per-part and per-file caps */
function partReader(zip: ZipBytes, lim: PictureLimits) {
  let spent = 0
  return async (entry: ZipEntry): Promise<string> => {
    if (entry.flags & 0x1) throw new Unknown()
    if (entry.csize > lim.maxPartBytes || entry.local + 30 > zip.size) throw new Unknown()
    const head = await zip.read(entry.local, 30)
    if (u32(head, 0) !== LOCAL_SIG) throw new Unknown()
    const start = entry.local + 30 + u16(head, 26) + u16(head, 28)
    if (start + entry.csize > zip.size) throw new Unknown()
    const data = await zip.read(start, entry.csize)
    let out: Uint8Array
    if (entry.method === 0) out = data
    else if (entry.method === 8) {
      try {
        out = inflateRawSync(data, { maxOutputLength: lim.maxPartBytes })
      } catch {
        throw new Unknown()
      }
    } else throw new Unknown()
    spent += out.length
    if (out.length > lim.maxPartBytes || spent > lim.maxTextBytes) throw new Unknown()
    return new TextDecoder('utf-8').decode(out)
  }
}

type ReadPart = (entry: ZipEntry) => Promise<string>

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
    out[m[1]!] = m[2] ?? m[3] ?? ''
  return out
}

function unescapeXml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** a relationship target resolved against the folder of `part` (zip root clamps `..`) */
function resolveIn(part: string, target: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(unescapeXml(target)).replace(/\\/g, '/')
  } catch {
    return ''
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(decoded)) return ''
  const slash = part.lastIndexOf('/')
  const parts = decoded.startsWith('/')
    ? []
    : (slash >= 0 ? part.slice(0, slash) : '').split('/').filter(Boolean)
  for (const seg of decoded.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

/** the `.rels` part that belongs to `part` */
function relsOf(part: string): string {
  const slash = part.lastIndexOf('/')
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`
}

/** the ids of relationships an embedded object (equation, OLE) uses for its preview */
function previewIds(xml: string, block: RegExp): Set<string> {
  const ids = new Set<string>()
  for (const m of xml.matchAll(block))
    for (const id of m[0].matchAll(/\br:(?:id|embed|pict)\s*=\s*"([^"]*)"/g)) ids.add(id[1]!)
  return ids
}

/** OPC: image relationships of the content parts, minus embedded-object previews */
async function opcTargets(
  entries: Map<string, ZipEntry>,
  read: ReadPart,
  content: RegExp,
  objectBlock: RegExp | null,
): Promise<Set<string>> {
  const targets = new Set<string>()
  for (const part of [...entries.keys()].filter((n) => content.test(n))) {
    const rels = entries.get(relsOf(part))
    if (!rels) continue
    const skip = objectBlock ? previewIds(await read(entries.get(part)!), objectBlock) : new Set()
    for (const m of (await read(rels)).matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)) {
      const a = attrs(m[0])
      if (!/\/image$/.test(a.Type ?? '') || a.TargetMode === 'External') continue
      if (a.Id !== undefined && skip.has(a.Id)) continue
      const target = resolveIn(part, a.Target ?? '')
      if (target) targets.add(target)
    }
  }
  return targets
}

/** the picture files the content of a `family` file places */
async function placedTargets(
  family: Family,
  entries: Map<string, ZipEntry>,
  read: ReadPart,
): Promise<Set<string> | 'anywhere'> {
  switch (family) {
    case 'docx':
      return opcTargets(
        entries,
        read,
        /^word\/(?:document\d*|header\d*|footer\d*|footnotes|endnotes)\.xml$/,
        /<w:object\b[\s\S]*?<\/w:object>/g,
      )
    case 'pptx':
      return opcTargets(
        entries,
        read,
        /^ppt\/(?:slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/,
        /<p:oleObj\b[\s\S]*?<\/p:oleObj>/g,
      )
    case 'xlsx':
      return opcTargets(entries, read, /^xl\/drawings\/drawing\d+\.xml$/, null)
    case 'odf': {
      const content = entries.get('content.xml')
      const targets = new Set<string>()
      if (!content) return targets
      for (const m of (await read(content)).matchAll(/xlink:href\s*=\s*"([^"]*)"/g)) {
        const target = resolveIn('content.xml', m[1]!)
        if (target.startsWith('Pictures/')) targets.add(target)
      }
      return targets
    }
    case 'hwpx': {
      const manifest = entries.get('Contents/content.hpf')
      const targets = new Set<string>()
      if (!manifest) return targets
      const hrefById = new Map<string, string>()
      for (const m of (await read(manifest)).matchAll(/<(?:\w+:)?item\b[^>]*>/g)) {
        const a = attrs(m[0])
        if (a.id && a.href) hrefById.set(a.id, resolveIn('', a.href))
      }
      for (const name of [...entries.keys()].filter((n) => /^Contents\/section\d+\.xml$/.test(n)))
        for (const m of (await read(entries.get(name)!)).matchAll(
          /binaryItemIDRef\s*=\s*"([^"]*)"/g,
        )) {
          const href = hrefById.get(unescapeXml(m[1]!))
          if (href) targets.add(href)
        }
      return targets
    }
    case 'epub':
      return 'anywhere'
  }
}

function isPictureEntry(entry: ZipEntry | undefined): entry is ZipEntry {
  if (!entry || entry.name.endsWith('/') || entry.usize < PICTURE_MIN_BYTES) return false
  const dot = entry.name.lastIndexOf('.')
  return dot >= 0 && PICTURE_EXTENSIONS.includes(entry.name.slice(dot + 1).toLowerCase())
}

async function countPictures(
  zip: ZipBytes,
  family: Family,
  lim: PictureLimits,
): Promise<number | null> {
  try {
    const entries = await readEntries(zip, lim)
    const placed = await placedTargets(family, entries, partReader(zip, lim))
    if (placed === 'anywhere') return [...entries.values()].filter(isPictureEntry).length
    return [...placed].filter((name) => isPictureEntry(entries.get(name))).length
  } catch {
    return null
  }
}

/**
 * Pictures in a whole zip held in memory, counted by the rule for
 * `fileName`'s type (tests and small callers); null when unknown. Never throws.
 */
export async function countZipPictures(
  bytes: Uint8Array,
  fileName: string,
  limits: Partial<PictureLimits> = {},
): Promise<number | null> {
  const family = pictureFamilyOf(fileName)
  if (!family) return null
  const zip: ZipBytes = {
    size: bytes.length,
    read: async (offset, length) => bytes.subarray(offset, offset + length),
  }
  return countPictures(zip, family, { ...DEFAULT_PICTURE_LIMITS, ...limits })
}

/** the same count reading only the parts it needs from the file */
async function countFilePictures(
  path: string,
  size: number,
  family: Family,
  lim: PictureLimits,
): Promise<number | null> {
  const handle = await open(path, 'r')
  try {
    const zip: ZipBytes = {
      size,
      async read(offset, length) {
        const buf = Buffer.alloc(length)
        const { bytesRead } = await handle.read(buf, 0, length, offset)
        if (bytesRead !== length) throw new Unknown()
        return buf
      },
    }
    return await countPictures(zip, family, lim)
  } finally {
    await handle.close()
  }
}

function isPlainName(file: string): boolean {
  return file !== '' && file !== '.' && file !== '..' && !/[\\/]/.test(file) && !file.includes('\0')
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path)
  } catch {
    return null
  }
}

async function resolvesInside(dir: string, path: string): Promise<boolean> {
  try {
    const [root, real] = await Promise.all([realpath(dir), realpath(path)])
    return real.startsWith(root.endsWith(sep) ? root : root + sep)
  } catch {
    return false
  }
}

/** `<dir>/<folder>/<file>` when it and its folder are real (not linked) and inside `dir` */
async function safeFile(
  dir: string,
  folder: string,
  file: string,
): Promise<{ path: string; st: Stats } | null> {
  if (!isPlainName(file)) return null
  const parent = join(dir, folder)
  const pst = await lstatOrNull(parent)
  if (!pst || pst.isSymbolicLink() || !pst.isDirectory()) return null
  const path = join(parent, file)
  const st = await lstatOrNull(path)
  if (!st || st.isSymbolicLink() || !st.isFile()) return null
  return (await resolvesInside(dir, path)) ? { path, st } : null
}

export interface PictureProjectLists {
  sources: readonly SourceEntry[]
  references: readonly string[]
}

export interface PictureInfo {
  forProject(dir: string, lists: PictureProjectLists): Promise<TranslatePictureInfo[]>
}

/** answers kept at most (a project lists far fewer files) */
const CACHE_MAX = 2000

export function createPictureInfo(limits: Partial<PictureLimits> = {}): PictureInfo {
  const lim = { ...DEFAULT_PICTURE_LIMITS, ...limits }
  const cache = new Map<string, number | null>()

  async function count(
    dir: string,
    folder: 'source' | 'references',
    file: string,
    sha256: string,
  ): Promise<number | null> {
    const family = pictureFamilyOf(file)
    if (family === null) return null
    try {
      const found = await safeFile(dir, folder, file)
      if (!found || found.st.size > lim.maxFileBytes) return null
      const key = [found.path, sha256, found.st.size, found.st.mtimeMs].join('\0')
      if (cache.has(key)) return cache.get(key)!
      const pictures = await countFilePictures(found.path, found.st.size, family, lim)
      if (cache.size >= CACHE_MAX) cache.clear()
      cache.set(key, pictures)
      return pictures
    } catch {
      return null
    }
  }

  return {
    async forProject(dir, lists) {
      const out: TranslatePictureInfo[] = []
      for (const source of lists.sources) {
        // images and scans already show as needing OCR; only editable documents are looked at
        const pictures =
          source.kind === 'editable' ? await count(dir, 'source', source.file, source.sha256) : null
        out.push({ file: source.file, kind: 'source', pictures })
      }
      for (const file of lists.references)
        out.push({ file, kind: 'reference', pictures: await count(dir, 'references', file, '') })
      return out
    },
  }
}
