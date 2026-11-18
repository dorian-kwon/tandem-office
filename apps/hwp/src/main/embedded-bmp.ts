import { createHash } from 'node:crypto'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import type * as CFB from 'cfb'
import { openHwp, recordsOf, writeContainer, type OpenedHwp } from './hwp5-file'

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

function imageBytes(opened: OpenedHwp, asset: Asset): Buffer {
  const entry = find(opened.cfb, asset.path)
  if (!entry || entry.type !== 2) return fail()
  const stored = content(entry)
  const bytes = asset.compressed ? inflateRawSync(stored, { maxOutputLength: MAX_IMAGE }) : stored
  if (bytes.length > MAX_IMAGE || bytes.length < 14 || bytes.toString('ascii', 0, 2) !== 'BM')
    return fail()
  return bytes
}

/** Build metadata only; each BMP is inflated alone and released before the next. */
function inspect(bytes: Uint8Array, signal?: AbortSignal): Plan {
  checkAbort(signal)
  if (bytes.length > MAX_SOURCE) return fail()
  const opened = openHwp(bytes)
  if (!opened) return fail()
  const { cfb } = opened
  const header = find(cfb, '/FileHeader')
  if (!header || header.type !== 2) return fail()
  const h = content(header)
  if (h.length < 256 || h[35] !== 5 || h[34] > 1 || h.readUInt32LE(36) & PROTECTED_FLAGS)
    return fail()
  const paths = new Set<string>()
  const root = cfb.FullPaths[0]
  if (!root) return fail()
  for (let i = 0; i < cfb.FullPaths.length; i++) {
    const entry = cfb.FileIndex[i]
    if (!entry || entry.type === 0) continue
    // A storage and a stream cannot share a name, even though storage paths end in '/'.
    const path = cfb.FullPaths[i].slice(root.length).replace(/\/$/, '').toLowerCase()
    if (
      paths.has(path) ||
      /(?:^|\/)(?:_?signdigit|digitalsignature|signatures?|certificate)(?:\/|$)/i.test(path)
    )
      return fail()
    paths.add(path)
  }
  const infoEntry = find(cfb, '/DocInfo')
  if (!infoEntry || infoEntry.type !== 2) return fail()
  const storedInfo = content(infoEntry)
  const info = opened.compressed
    ? inflateRawSync(storedInfo, { maxOutputLength: MAX_DOC_INFO })
    : storedInfo
  if (info.length > MAX_DOC_INFO) return fail()
  const records = recordsOf(info)
  if (!records) return fail()
  const ids = new Set<number>()
  const assets: Asset[] = []
  for (const record of records) {
    if (record.tag !== BIN_DATA) continue
    if (record.end - record.body < 2) return fail()
    const attr = info.readUInt16LE(record.body)
    const type = attr & 15
    if (type === 0) continue // External links are never followed.
    if ((type !== 1 && type !== 2) || record.end - record.body < 4) return fail()
    const id = info.readUInt16LE(record.body + 2)
    if (!id || ids.has(id)) return fail()
    ids.add(id)
    if (type !== 1) continue // OLE storages are not images.
    if (record.end - record.body < 6) return fail()
    const length = info.readUInt16LE(record.body + 4)
    const extensionOffset = record.body + 6
    if (extensionOffset + length * 2 > record.end) return fail()
    const extension = info.toString('utf16le', extensionOffset, extensionOffset + length * 2)
    if (extension.toLowerCase() !== 'bmp') continue
    const compression = (attr >> 4) & 3
    if (compression === 3) return fail()
    const basename = `BIN${id.toString(16).toUpperCase().padStart(4, '0')}`
    const entry = find(cfb, `/BinData/${basename}.${extension}`)
    if (!entry || entry.type !== 2) return fail()
    const index = cfb.FileIndex.indexOf(entry)
    const path = '/' + cfb.FullPaths[index].slice(root.length)
    const target = path.slice(0, -3) + 'jpg'
    if (paths.has(target.slice(1).toLowerCase())) return fail()
    assets.push({
      path,
      target,
      extensionOffset,
      compressed: compression === 1 || (compression === 0 && opened.compressed),
    })
  }
  const recognized = new Set(assets.map((asset) => asset.path.slice(1).toLowerCase()))
  for (const path of paths) {
    if (/^bindata\/[^/]+\.bmp$/i.test(path) && !recognized.has(path)) return fail()
  }
  let bmpBytes = 0
  for (const asset of assets) {
    checkAbort(signal)
    imageBytes(opened, asset)
    bmpBytes += content(find(cfb, asset.path)!).length
  }
  return { opened, info, assets, bmpBytes }
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
