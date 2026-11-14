import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, extname, posix } from 'node:path'
import { crc32, inflateRawSync } from 'node:zlib'
import { decodeEntities } from '@genoffice/docx-engine'
import { readZipEntries, type ByteSource, type ZipEntry } from '@genoffice/docx-engine/zip-splice'
import type { OcrPageImage } from '../../shared/translate-ocr'
import { inspectBoxableImage } from './ocr-boxes-docx'

const MAX_ARCHIVE = 128 * 1024 * 1024
const MAX_IMAGE = 20 * 1024 * 1024
const MAX_XML = 4 * 1024 * 1024
const MAX_XML_TOTAL = 16 * 1024 * 1024
const LIMITS = { maxParts: 10000, maxPartBytes: MAX_IMAGE, maxTotalBytes: 256 * 1024 * 1024 }

/** Internal descriptors never cross IPC; image bytes are read only when needed. */
export interface EmbeddedImage {
  name: string
  location: string
  entry: ZipEntry
  signature: string
  /** the package part that holds the reference, for example `word/document.xml` */
  part: string
  /** the relationship id of the picture inside that part */
  relId: string
  /** a docx picture that can take boxes (alone on a left-aligned body paragraph); absent = no */
  boxable?: boolean
}

export const supportsEmbeddedOcr = (file: string): boolean => /\.(docx|xlsx)$/i.test(file)

async function source(path: string) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_ARCHIVE) throw new Error('unsupported OCR archive size')
    const signature = [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':')
    const bytes: ByteSource = {
      size: info.size,
      async read(offset, length) {
        if (
          !Number.isSafeInteger(offset) ||
          !Number.isSafeInteger(length) ||
          offset < 0 ||
          length < 0 ||
          offset + length > info.size
        )
          throw new Error('ZIP part is outside the archive')
        const out = Buffer.alloc(length)
        let done = 0
        while (done < length) {
          const { bytesRead } = await handle.read(out, done, length - done, offset + done)
          if (!bytesRead) throw new Error('ZIP part was truncated')
          done += bytesRead
        }
        return out
      },
    }
    return { handle, bytes, signature }
  } catch (err) {
    await handle.close()
    throw err
  }
}

async function readPart(src: ByteSource, entry: ZipEntry, limit: number): Promise<Buffer> {
  if (entry.usize > limit || entry.csize > limit || entry.flags & 1)
    throw new Error('OCR archive part exceeds its limit')
  const raw = await src.read(entry.dataOffset, entry.csize)
  const data =
    entry.method === 0
      ? raw
      : entry.method === 8
        ? inflateRawSync(raw, { maxOutputLength: Math.min(limit, entry.usize) + 1 })
        : null
  if (!data || data.length !== entry.usize || data.length > limit || crc32(data) !== entry.crc)
    throw new Error('invalid OCR archive part')
  return data
}

function attrs(tag: string): Record<string, string> {
  return Object.fromEntries(
    [...tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => [
      m[1]!,
      decodeEntities(m[2] ?? m[3] ?? ''),
    ]),
  )
}

function target(part: string, value: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(value).replace(/\\/g, '/')
  } catch {
    return ''
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(decoded) || decoded.startsWith('//')) return ''
  const resolved = posix.normalize(
    decoded.startsWith('/') ? decoded.slice(1) : posix.join(posix.dirname(part), decoded),
  )
  return resolved === '..' || resolved.startsWith('../') ? '' : resolved
}

/** Enumerate content references, never the media folder or external targets. */
export async function listEmbeddedImages(path: string): Promise<EmbeddedImage[]> {
  if (!supportsEmbeddedOcr(path)) throw new Error('only DOCX and XLSX support embedded OCR')
  const src = await source(path)
  try {
    const entries = new Map((await readZipEntries(src.bytes, LIMITS)).map((e) => [e.name, e]))
    const cache = new Map<string, string>()
    let xmlBytes = 0
    const text = async (part: string): Promise<string> => {
      if (cache.has(part)) return cache.get(part)!
      const entry = entries.get(part)
      if (!entry) return ''
      const data = await readPart(src.bytes, entry, MAX_XML)
      xmlBytes += data.length
      if (xmlBytes > MAX_XML_TOTAL) throw new Error('OCR XML exceeds its limit')
      const value = data.toString('utf8')
      cache.set(part, value)
      return value
    }
    const relCache = new Map<string, Map<string, { path: string; type: string }>>()
    const relationships = async (part: string) => {
      if (relCache.has(part)) return relCache.get(part)!
      const xml = await text(posix.join(posix.dirname(part), '_rels', basename(part) + '.rels'))
      const rels = new Map<string, { path: string; type: string }>()
      for (const m of xml.matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)) {
        const a = attrs(m[0])
        if (/^external$/i.test(a.TargetMode ?? '')) continue
        const path = target(part, a.Target ?? '')
        if (a.Id && path) rels.set(a.Id, { path, type: a.Type ?? '' })
      }
      relCache.set(part, rels)
      return rels
    }
    const images: EmbeddedImage[] = []
    const seen = new Set<string>()
    const add = async (part: string, id: string, location: string, boxable = false) => {
      const rel = (await relationships(part)).get(id)
      if (
        !rel ||
        !/\/image$/i.test(rel.type) ||
        seen.has(rel.path) ||
        !/\.(png|jpe?g)$/i.test(rel.path)
      )
        return
      const entry = entries.get(rel.path)
      if (!entry || entry.usize === 0) return
      seen.add(rel.path)
      images.push({
        name: basename(rel.path),
        location,
        entry,
        signature: src.signature,
        part,
        relId: id,
        ...(boxable ? { boxable: true } : {}),
      })
    }
    if (extname(path).toLowerCase() === '.docx') {
      const parts = [...entries.keys()]
        .filter((n) => /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(n))
        .sort((a, b) =>
          a === 'word/document.xml'
            ? -1
            : b === 'word/document.xml'
              ? 1
              : a.localeCompare(b, 'en', { numeric: true }),
        )
      for (const part of parts) {
        const xml = (await text(part)).replace(
          /<(?:\w+:)?object\b[\s\S]*?<\/(?:\w+:)?object\s*>/g,
          '',
        )
        const raw = await text(part)
        let paragraph = 0
        for (const m of xml.matchAll(/<(?:\w+:)?(p|blip|imagedata)\b[^>]*>/g)) {
          if (m[1] === 'p') {
            paragraph++
            continue
          }
          const a = attrs(m[0])
          const id = a['r:embed'] ?? a['r:id']
          if (id) {
            const at = Math.max(1, paragraph)
            await add(
              part,
              id,
              `${basename(part)} · ¶${at}`,
              m[1] === 'blip' && inspectBoxableImage(part, raw, at, id).ok,
            )
          }
        }
      }
    } else {
      const workbook = 'xl/workbook.xml'
      const sheets = await relationships(workbook)
      for (const m of (await text(workbook)).matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)) {
        const a = attrs(m[0])
        const sheet = sheets.get(a['r:id'] ?? '')?.path
        if (!sheet) continue
        const sheetRels = await relationships(sheet)
        for (const d of (await text(sheet)).matchAll(/<(?:\w+:)?drawing\b[^>]*>/g)) {
          const drawing = sheetRels.get(attrs(d[0])['r:id'] ?? '')?.path
          if (!drawing) continue
          // Excel appends a picture to the drawing in the order it was added, not by position:
          // the list follows the sheet, top to bottom then left to right (ties and anchors
          // without a cell keep their stored order, those last).
          const anchors = [
            ...(await text(drawing)).matchAll(
              /<(?:\w+:)?(twoCellAnchor|oneCellAnchor|absoluteAnchor)\b[\s\S]*?<\/(?:\w+:)?\1\s*>/g,
            ),
          ].map((anchor, order) => {
            const from =
              anchor[0].match(/<(?:\w+:)?from\b[^>]*>([\s\S]*?)<\/(?:\w+:)?from\s*>/)?.[1] ?? ''
            const col = Number(from.match(/<(?:\w+:)?col\b[^>]*>(\d+)<\/(?:\w+:)?col>/)?.[1] ?? NaN)
            const row = Number(from.match(/<(?:\w+:)?row\b[^>]*>(\d+)<\/(?:\w+:)?row>/)?.[1] ?? NaN)
            return { anchor, col, row, order }
          })
          const place = (n: number): number => (Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER)
          anchors.sort(
            (a, b) =>
              place(a.row) - place(b.row) || place(a.col) - place(b.col) || a.order - b.order,
          )
          for (const { anchor, col, row } of anchors) {
            let cell = ''
            if (col >= 0 && col < 16384 && row >= 0 && row < 1048576) {
              let c = col + 1
              while (c > 0) {
                cell = String.fromCharCode(65 + ((c - 1) % 26)) + cell
                c = Math.floor((c - 1) / 26)
              }
              cell += row + 1
            }
            for (const blip of anchor[0].matchAll(/<(?:\w+:)?blip\b[^>]*>/g)) {
              const id = attrs(blip[0])['r:embed']
              if (id) await add(drawing, id, [a.name, cell].filter(Boolean).join(' · '))
            }
          }
        }
      }
    }
    return images
  } finally {
    await src.handle.close()
  }
}

/** Read a descriptor from the same source version that was listed. */
export async function readEmbeddedImage(path: string, image: EmbeddedImage): Promise<OcrPageImage> {
  const src = await source(path)
  try {
    if (src.signature !== image.signature) throw new Error('OCR source changed after listing')
    const data = new Uint8Array(await readPart(src.bytes, image.entry, MAX_IMAGE))
    const mime =
      data.length >= 8 &&
      Buffer.from(data.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? 'image/png'
        : data[0] === 255 && data[1] === 216 && data[2] === 255
          ? 'image/jpeg'
          : null
    if (!mime) throw new Error('only PNG and JPEG images can be read')
    return { data, mime }
  } finally {
    await src.handle.close()
  }
}
