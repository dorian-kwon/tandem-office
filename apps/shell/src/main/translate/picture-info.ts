import type { Stats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { extname, join, sep } from 'node:path'
import type { SourceEntry } from '@genoffice/translate-project'
import type { TranslatePictureInfo } from '../../shared/translate-api'

/**
 * Pictures embedded in a translation project's sources and references
 * (`translate:picture-info`). Text inside a picture is not part of the
 * document text, so it is never translated; the detail screen says so next
 * to the file and points at the OCR route that exists (a scan PDF or an
 * image added as a source).
 *
 * How pictures are counted (read-only, nothing is inflated or written):
 * - Only zip-based formats: the picture files in the format's media folder
 *   (`pictureFolderOf`), read from the archive's central directory alone.
 *   An EPUB counts image files anywhere in the book.
 * - A picture is a file with a raster or Office metafile extension
 *   (`PICTURE_EXTENSIONS`; SVG is left out because Office stores a PNG copy
 *   beside each SVG) of at least `PICTURE_MIN_BYTES` uncompressed bytes, so
 *   bullets, lines and other tiny decorations do not count. The same picture
 *   used on several pages is one file and counts once.
 * - PDFs, images, binary Office/HWP files and plain text give `null`: images
 *   and scans already go through the OCR kind logic, and the rest is not
 *   covered.
 *
 * Safety: a file larger than `maxFileBytes`, a central directory larger than
 * `maxCentralBytes` or with more than `maxEntries` entries, zip64 and any
 * structural damage give `null` (unknown, shown as no notice); nothing here
 * throws. Only the file's tail is read. A file or folder that is a link, or
 * resolves outside the project folder, is never opened.
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
}

export const DEFAULT_PICTURE_LIMITS: PictureLimits = {
  maxFileBytes: 1024 * 1024 * 1024,
  maxCentralBytes: 16 * 1024 * 1024,
  maxEntries: 20_000,
}

const FOLDERS: Record<string, string> = {
  docx: 'word/media/',
  docm: 'word/media/',
  dotx: 'word/media/',
  pptx: 'ppt/media/',
  pptm: 'ppt/media/',
  ppsx: 'ppt/media/',
  potx: 'ppt/media/',
  xlsx: 'xl/media/',
  xlsm: 'xl/media/',
  odt: 'Pictures/',
  ods: 'Pictures/',
  odp: 'Pictures/',
  hwpx: 'BinData/',
  epub: '',
}

/** the folder inside the archive whose picture files count ('' = anywhere); null: not covered */
export function pictureFolderOf(fileName: string): string | null {
  const ext = extname(fileName).slice(1).toLowerCase()
  return Object.prototype.hasOwnProperty.call(FOLDERS, ext) ? FOLDERS[ext]! : null
}

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const EOCD_MIN = 22
/** the end record plus the longest comment a zip may carry */
const TAIL_BYTES = EOCD_MIN + 0xffff

interface CentralDirectory {
  entries: number
  offset: number
  size: number
}

function u16(b: Uint8Array, at: number): number {
  return b[at]! | (b[at + 1]! << 8)
}

function u32(b: Uint8Array, at: number): number {
  return (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0
}

/** the end-of-central-directory record in `tail` (the last bytes of a `fileSize` file) */
function locate(
  tail: Uint8Array,
  fileSize: number,
  limits: PictureLimits,
): CentralDirectory | null {
  for (let at = tail.length - EOCD_MIN; at >= 0; at -= 1) {
    if (u32(tail, at) !== EOCD_SIG) continue
    const entries = u16(tail, at + 10)
    const size = u32(tail, at + 12)
    const offset = u32(tail, at + 16)
    // zip64 markers: not handled, so unknown
    if (entries === 0xffff || size === 0xffffffff || offset === 0xffffffff) return null
    if (entries > limits.maxEntries || size > limits.maxCentralBytes) return null
    if (offset + size > fileSize) return null
    return { entries, offset, size }
  }
  return null
}

function isPictureName(name: string, folder: string): boolean {
  if (name.endsWith('/') || !name.startsWith(folder)) return false
  const dot = name.lastIndexOf('.')
  return dot >= 0 && PICTURE_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase())
}

/** count the pictures in a central directory's bytes; null when it is damaged */
function countEntries(cd: Uint8Array, entries: number, folder: string): number | null {
  const decoder = new TextDecoder('utf-8')
  let at = 0
  let count = 0
  for (let i = 0; i < entries; i += 1) {
    if (at + 46 > cd.length || u32(cd, at) !== CENTRAL_SIG) return null
    const usize = u32(cd, at + 24)
    const nameLen = u16(cd, at + 28)
    const next = at + 46 + nameLen + u16(cd, at + 30) + u16(cd, at + 32)
    if (next > cd.length) return null
    const name = decoder.decode(cd.subarray(at + 46, at + 46 + nameLen))
    if (isPictureName(name, folder) && usize >= PICTURE_MIN_BYTES) count += 1
    at = next
  }
  return count
}

/**
 * Pictures in a whole zip held in memory (tests and small callers); null when
 * the bytes are not a zip this reader takes. Never throws.
 */
export function countZipPictures(
  bytes: Uint8Array,
  folder: string,
  limits: Partial<PictureLimits> = {},
): number | null {
  const lim = { ...DEFAULT_PICTURE_LIMITS, ...limits }
  try {
    const tail = bytes.subarray(Math.max(0, bytes.length - TAIL_BYTES))
    const cd = locate(tail, bytes.length, lim)
    if (!cd) return null
    return countEntries(bytes.subarray(cd.offset, cd.offset + cd.size), cd.entries, folder)
  } catch {
    return null
  }
}

/** the same count reading only the file's tail and its central directory */
async function countFilePictures(
  path: string,
  size: number,
  folder: string,
  lim: PictureLimits,
): Promise<number | null> {
  const handle = await open(path, 'r')
  try {
    const tailLen = Math.min(size, TAIL_BYTES)
    const tail = Buffer.alloc(tailLen)
    await handle.read(tail, 0, tailLen, size - tailLen)
    const cd = locate(tail, size, lim)
    if (!cd) return null
    const bytes = Buffer.alloc(cd.size)
    const { bytesRead } = await handle.read(bytes, 0, cd.size, cd.offset)
    if (bytesRead !== cd.size) return null
    return countEntries(bytes, cd.entries, folder)
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
    const inner = pictureFolderOf(file)
    if (inner === null) return null
    try {
      const found = await safeFile(dir, folder, file)
      if (!found || found.st.size > lim.maxFileBytes) return null
      const key = [found.path, sha256, found.st.size, found.st.mtimeMs].join('\0')
      if (cache.has(key)) return cache.get(key)!
      const pictures = await countFilePictures(found.path, found.st.size, inner, lim)
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
