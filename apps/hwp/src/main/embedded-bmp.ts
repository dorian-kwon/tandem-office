import { createHash } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createInflateRaw, deflateRawSync, inflateRawSync } from 'node:zlib'
import type * as CFB from 'cfb'
import { openCfbFile, type CfbFileReader } from './cfb-file-reader'
import {
  COMPRESSED,
  DOC_INFO,
  FILE_HEADER,
  SIGNATURE,
  openHwp,
  readHwpContainer,
  visitHwpRecords,
  writeContainer,
  type OpenedHwp,
} from './hwp5-file'

const MAX_SOURCE = 2 * 1024 * 1024 * 1024
const MAX_IMAGE = 192 * 1024 * 1024
const MAX_DOC_INFO = 64 * 1024 * 1024
const BIN_DATA = 18
// Password/distribution/DRM/signature/public-key/certificate/distribution-preparation.
const PROTECTED_FLAGS = 0x796

interface Asset {
  path: string
  target: string
  compressed: boolean
  extensionOffset: number
}
interface Plan {
  opened: OpenedHwp
  info: Buffer
  assets: Asset[]
  bmpBytes: number
}
export interface HwpBmpOptions {
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void
}

const fail = (): never => {
  throw new Error('HWP BMP optimization: unsupported or ambiguous container')
}
const view = (bytes: Uint8Array): Buffer =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
const content = (entry: CFB.CFB$Entry): Buffer => view(entry.content as Uint8Array)
const checkAbort = (signal?: AbortSignal): void => {
  signal?.throwIfAborted()
}
// CFB.find also tries basename/control-character aliases; replacements require exact paths.
function find(cfb: CFB.CFB$Container, path: string): CFB.CFB$Entry | undefined {
  const full = (cfb.FullPaths[0] + path.slice(1)).toLowerCase()
  const index = cfb.FullPaths.findIndex((name) => name.toLowerCase() === full)
  return index < 0 ? undefined : cfb.FileIndex[index]
}

function checkBitmap(prefix: Buffer, length: number): void {
  if (length < 14 || length > MAX_IMAGE || prefix[0] !== 0x42 || prefix[1] !== 0x4d) fail()
}

function imageBytes(opened: OpenedHwp, asset: Asset): Buffer {
  const entry = find(opened.cfb, asset.path)
  if (!entry || entry.type !== 2) return fail()
  const stored = content(entry)
  const bytes = asset.compressed ? inflateRawSync(stored, { maxOutputLength: MAX_IMAGE }) : stored
  checkBitmap(bytes, bytes.length)
  return bytes
}

type DirectoryEntry = CfbFileReader['entries'][number]

function checkedDirectory(entries: Iterable<DirectoryEntry>): Map<string, DirectoryEntry> {
  const paths = new Map<string, DirectoryEntry>()
  for (const entry of entries) {
    const path = entry.path.toLowerCase()
    if (
      paths.has(path) ||
      /(?:^|\/)(?:_?signdigit|digitalsignature|signatures?|certificate)(?:\/|$)/.test(path) ||
      path.includes('/viewtext/') ||
      (entry.type === 'storage' && path.endsWith('/viewtext'))
    )
      return fail()
    paths.set(path, entry)
  }
  return paths
}

function requiredStream(paths: Map<string, DirectoryEntry>, name: string): DirectoryEntry {
  const entry = paths.get(name.toLowerCase())
  return entry?.type === 'stream' ? entry : fail()
}

function headerCompression(header: Buffer): boolean {
  if (
    header.length < 256 ||
    header.toString('latin1', 0, SIGNATURE.length) !== SIGNATURE ||
    header[35] !== 5 ||
    header[34] > 1 ||
    header.readUInt32LE(36) & PROTECTED_FLAGS
  )
    return fail()
  return Boolean(header.readUInt32LE(36) & COMPRESSED)
}

function bmpAssets(info: Buffer, paths: Map<string, DirectoryEntry>, compressed: boolean): Asset[] {
  if (info.length > MAX_DOC_INFO) return fail()
  const ids = new Set<number>()
  const assets: Asset[] = []
  const valid = visitHwpRecords(info, (record) => {
    if (record.tag !== BIN_DATA) return
    if (record.end - record.body < 2) return fail()
    const attr = info.readUInt16LE(record.body)
    const type = attr & 15
    if (type === 0) return // External links are never followed.
    if ((type !== 1 && type !== 2) || record.end - record.body < 4) return fail()
    const id = info.readUInt16LE(record.body + 2)
    if (!id || ids.has(id)) return fail()
    ids.add(id)
    if (type !== 1) return // OLE storages are not images.
    if (record.end - record.body < 6) return fail()
    const length = info.readUInt16LE(record.body + 4)
    const extensionOffset = record.body + 6
    if (extensionOffset + length * 2 > record.end) return fail()
    const extension = info.toString('utf16le', extensionOffset, extensionOffset + length * 2)
    if (extension.toLowerCase() !== 'bmp') return
    const compression = (attr >> 4) & 3
    if (compression === 3) return fail()
    const basename = `BIN${id.toString(16).toUpperCase().padStart(4, '0')}`
    const { path } = requiredStream(paths, `/BinData/${basename}.${extension}`)
    const target = path.slice(0, -3) + 'jpg'
    if (paths.has(target.toLowerCase())) return fail()
    assets.push({
      path,
      target,
      extensionOffset,
      compressed: compression === 1 || (compression === 0 && compressed),
    })
  })
  if (!valid) return fail()
  const recognized = new Set(assets.map((asset) => asset.path.toLowerCase()))
  for (const path of paths.keys()) {
    if (/^\/bindata\/[^/]+\.bmp$/.test(path) && !recognized.has(path)) return fail()
  }
  return assets
}

function inspect(bytes: Uint8Array, signal?: AbortSignal): Plan {
  checkAbort(signal)
  if (bytes.length > MAX_SOURCE) return fail()
  const cfb = readHwpContainer(bytes)
  const root = cfb.FullPaths[0]
  if (!root || cfb.FileIndex[0]?.type !== 5) return fail()
  const entries: DirectoryEntry[] = []
  for (let i = 1; i < cfb.FileIndex.length; i++) {
    const entry = cfb.FileIndex[i]
    if (!entry || entry.type === 0) continue
    if (entry.type !== 1 && entry.type !== 2) return fail()
    entries.push({
      path: '/' + cfb.FullPaths[i].slice(root.length).replace(/\/$/, ''),
      type: entry.type === 1 ? 'storage' : 'stream',
      size: entry.size,
    })
  }
  const paths = checkedDirectory(entries)
  const raw = (path: string) => content(find(cfb, requiredStream(paths, path).path)!)
  const compressed = headerCompression(raw(FILE_HEADER))
  const storedInfo = raw(DOC_INFO)
  const info = compressed
    ? inflateRawSync(storedInfo, { maxOutputLength: MAX_DOC_INFO })
    : storedInfo
  const assets = bmpAssets(info, paths, compressed)
  const opened = { cfb, compressed }
  let bmpBytes = 0
  for (const asset of assets) {
    checkAbort(signal)
    imageBytes(opened, asset)
    bmpBytes += content(find(cfb, asset.path)!).length
  }
  return { opened, info, assets, bmpBytes }
}

/** Validate the entire deflate member while retaining only the bytes the caller needs. */
async function inflateForInspection(
  stored: AsyncIterable<Buffer>,
  limit: number,
  keep: number,
): Promise<{ bytes: Buffer; length: number }> {
  let saved = Buffer.alloc(0)
  let length = 0
  await pipeline(
    stored,
    createInflateRaw({ chunkSize: 512 * 1024 }),
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        const offset = length
        length += chunk.length
        if (length > limit) {
          done(new Error('HWP stream exceeds its inspection limit'))
          return
        }
        if (offset < keep) {
          const end = Math.min(keep, length)
          if (end > saved.length) {
            const capacity = Math.min(keep, Math.max(end, 4096, saved.length * 2))
            const grown = Buffer.allocUnsafe(capacity)
            saved.copy(grown, 0, 0, offset)
            saved = grown
          }
          chunk.copy(saved, offset, 0, end - offset)
        }
        done()
      },
    }),
  )
  return { bytes: saved.subarray(0, Math.min(keep, length)), length }
}

async function inspectBitmap(cfb: CfbFileReader, asset: Asset, size: number): Promise<void> {
  if (asset.compressed) {
    const { bytes, length } = await inflateForInspection(cfb.chunks(asset.path), MAX_IMAGE, 2)
    checkBitmap(bytes, length)
  } else {
    checkBitmap(await cfb.prefix(asset.path, 2), size)
  }
}

/** Inspect only the header, document metadata and BMP streams of an already-open HWP. */
export async function inspectHwpBmpFile(
  file: FileHandle,
  size: number,
): Promise<{ count: number; bmpBytes: number } | null> {
  try {
    if (size > MAX_SOURCE) return null
    const cfb = await openCfbFile(file, size)
    const paths = checkedDirectory(cfb.entries)
    const header = requiredStream(paths, FILE_HEADER)
    const compressed = headerCompression(await cfb.prefix(header.path, 256))
    const docInfo = requiredStream(paths, DOC_INFO)
    if (!compressed && docInfo.size > MAX_DOC_INFO) return null
    const info = compressed
      ? (await inflateForInspection(cfb.chunks(docInfo.path), MAX_DOC_INFO, MAX_DOC_INFO)).bytes
      : await cfb.prefix(docInfo.path, docInfo.size)
    const assets = bmpAssets(info, paths, compressed)
    let bmpBytes = 0
    // Two native inflaters keep large reports moving with bounded memory. Both
    // reads must finish on failure before the caller can close the shared file.
    for (let i = 0; i < assets.length; i += 2) {
      const checks = assets.slice(i, i + 2).map(async (asset) => {
        const { size } = requiredStream(paths, asset.path)
        await inspectBitmap(cfb, asset, size)
        return size
      })
      for (const result of await Promise.allSettled(checks)) {
        if (result.status === 'rejected') return null
        bmpBytes += result.value
      }
    }
    return { count: assets.length, bmpBytes }
  } catch {
    return null
  }
}

/** Null means this container cannot safely be inspected/replaced by this adapter. */
export function inspectHwpBmp(bytes: Uint8Array): { count: number; bmpBytes: number } | null {
  try {
    const plan = inspect(bytes)
    return { count: plan.assets.length, bmpBytes: plan.bmpBytes }
  } catch {
    return null
  }
}

const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
function inventory(cfb: CFB.CFB$Container): Map<string, string> {
  const result = new Map<string, string>()
  const root = cfb.FullPaths[0]
  for (let i = 0; i < cfb.FullPaths.length; i++) {
    const entry = cfb.FileIndex[i]
    if (!entry || entry.type === 0) continue
    const path = '/' + cfb.FullPaths[i].slice(root.length)
    result.set(path, `${entry.type}:${entry.type === 2 ? digest(content(entry)) : ''}`)
  }
  return result
}

/** Only the original asset IDs' bytes and DocInfo extensions change; no engine export. */
export async function optimizeHwpBmp(
  bytes: Uint8Array,
  encode: (bmp: Buffer) => Promise<Buffer | null>,
  options: HwpBmpOptions = {},
): Promise<{ bytes: Buffer; converted: number; skipped: number }> {
  const { signal, onProgress } = options
  const { opened, info, assets } = inspect(bytes, signal)
  const expected = inventory(opened.cfb)
  const nextInfo = Buffer.from(info)
  let converted = 0
  let skipped = 0
  for (const asset of assets) {
    checkAbort(signal)
    const bmp = imageBytes(opened, asset)
    const jpeg = await encode(bmp)
    checkAbort(signal)
    if (jpeg === null || jpeg.length >= bmp.length) {
      skipped++
    } else {
      if (
        jpeg.length < 4 ||
        jpeg[0] !== 0xff ||
        jpeg[1] !== 0xd8 ||
        jpeg[2] !== 0xff ||
        jpeg[jpeg.length - 2] !== 0xff ||
        jpeg[jpeg.length - 1] !== 0xd9
      )
        return fail()
      const replacement = asset.compressed ? deflateRawSync(jpeg) : jpeg
      const entry = find(opened.cfb, asset.path)!
      if (replacement.length >= content(entry).length) {
        skipped++
        onProgress?.(converted + skipped, assets.length)
        continue
      }
      // Replacing the CFB entry does not mutate the input buffer's storage.
      entry.content = replacement
      entry.size = replacement.length
      // cfb_mov initializes a library marker stream, which would alter an unrelated
      // document part. writeContainer rebuilds directory links from these paths.
      const index = opened.cfb.FileIndex.indexOf(entry)
      entry.name = asset.target.slice(asset.target.lastIndexOf('/') + 1)
      opened.cfb.FullPaths[index] = opened.cfb.FullPaths[0] + asset.target.slice(1)
      nextInfo.write('jpg', asset.extensionOffset, 'utf16le')
      expected.delete(asset.path)
      expected.set(asset.target, `2:${digest(replacement)}`)
      converted++
    }
    onProgress?.(converted + skipped, assets.length)
  }
  checkAbort(signal)
  if (!converted) return { bytes: view(bytes), converted, skipped }
  const entry = find(opened.cfb, '/DocInfo')!
  const replacement = opened.compressed ? deflateRawSync(nextInfo) : nextInfo
  entry.content = replacement
  entry.size = replacement.length
  const infoPath =
    '/' +
    opened.cfb.FullPaths[opened.cfb.FileIndex.indexOf(entry)].slice(opened.cfb.FullPaths[0].length)
  expected.set(infoPath, `2:${digest(replacement)}`)
  const written = writeContainer(opened.cfb)
  checkAbort(signal)
  const check = openHwp(written)
  if (!check) return fail()
  const actual = inventory(check.cfb)
  if (
    actual.size !== expected.size ||
    [...expected].some(([path, hash]) => actual.get(path) !== hash)
  )
    return fail()
  return { bytes: written, converted, skipped }
}
