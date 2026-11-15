import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, extname, posix } from 'node:path'
import { crc32, inflateRawSync } from 'node:zlib'
import { decodeEntities } from '@genoffice/docx-engine'
import { readZipEntries, type ByteSource, type ZipEntry } from '@genoffice/docx-engine/zip-splice'
import type { OcrPageImage } from '../../shared/translate-ocr'
import { inspectBoxableImage } from './ocr-boxes-docx'
import { openHwp } from '../../../../hwp/src/main/hwp5-file'
import { createHash } from 'node:crypto'
import { hwpPicturePlaces } from '@genoffice/file-parse/hwp'
import { orderByPlaces } from './picture-order'

const MAX_ARCHIVE = 128 * 1024 * 1024
const MAX_IMAGE = 20 * 1024 * 1024
const MAX_XML = 4 * 1024 * 1024
const MAX_XML_TOTAL = 16 * 1024 * 1024
const LIMITS = { maxParts: 10000, maxPartBytes: MAX_IMAGE, maxTotalBytes: 256 * 1024 * 1024 }

/** Internal descriptors never cross IPC; image bytes are read only when needed. */
export interface EmbeddedImage {
  name: string
  location: string
  /** the picture's part of the zip package; absent for a picture of a HWP file */
  entry?: ZipEntry
  /** reads the picture by itself when it is not a part of a zip package (HWP) */
  read?: () => Promise<OcrPageImage>
  signature: string
  /** the package part that holds the reference, for example `word/document.xml` */
  part: string
  /** the relationship id of the picture inside that part */
  relId: string
  /** a docx picture that can take boxes (alone on a left-aligned body paragraph); absent = no */
  boxable?: boolean
  /** the page the picture is on, when the file says so; absent when it cannot be known */
  page?: number
  /** the page was counted from hard page breaks only, so the picture may be on a later page */
  pageApprox?: true
}

export const supportsEmbeddedOcr = (file: string): boolean => /\.(docx|xlsx)$/i.test(file)

/** Hangul documents: their pictures are taken out and read, and the text goes into a new Word document */
export const supportsExtractedOcr = (file: string): boolean => /\.(hwpx|hwp)$/i.test(file)

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

const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function pictureMime(data: Uint8Array): 'image/png' | 'image/jpeg' | null {
  if (data.length >= 8 && Buffer.from(data.subarray(0, 8)).equals(PNG_MAGIC)) return 'image/png'
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg'
  return null
}

/**
 * The pictures of a HWP 5 file, from its BinData streams in name order. A stream is deflated
 * when the document says so, but a picture can also be stored as it is, so the picture header
 * decides: the bytes as they are, else inflated.
 */
async function listHwpImages(path: string): Promise<EmbeddedImage[]> {
  const load = async () => {
    const src = await source(path)
    try {
      const bytes = new Uint8Array(await src.bytes.read(0, src.bytes.size))
      return { bytes, signature: src.signature }
    } finally {
      await src.handle.close()
    }
  }
  const { bytes, signature } = await load()
  const opened = openHwp(bytes)
  if (!opened)
    throw new Error(
      'this Hangul document cannot be read: it is encrypted, protected for distribution, or damaged',
    )
  const names = opened.cfb.FullPaths.map((full, i) => ({ full, entry: opened.cfb.FileIndex[i]! }))
    .filter(
      ({ full, entry }) => /\/BinData\/BIN[^/]*\.(png|jpe?g)$/i.test(full) && (entry.size ?? 0) > 0,
    )
    .map(({ full }) => full)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  const images: EmbeddedImage[] = names.map((full) => {
    const name = basename(full)
    return {
      name,
      location: 'BinData',
      signature,
      part: `BinData/${name}`,
      relId: name,
      read: async () => {
        const again = await load()
        if (again.signature !== signature) throw new Error('OCR source changed after listing')
        const reopened = openHwp(again.bytes)
        const entry = reopened?.cfb.FileIndex[reopened.cfb.FullPaths.indexOf(full)]
        if (!reopened || !entry?.content)
          throw new Error('this picture is no longer in the document')
        const stored = new Uint8Array(entry.content as Uint8Array)
        let data: Uint8Array | null = pictureMime(stored) ? stored : null
        if (!data) {
          try {
            data = new Uint8Array(inflateRawSync(stored, { maxOutputLength: MAX_IMAGE + 1 }))
          } catch {
            data = null
          }
        }
        const mime = data ? pictureMime(data) : null
        if (!data || !mime || data.length > MAX_IMAGE)
          throw new Error('only PNG and JPEG images can be read')
        return { data, mime }
      },
    }
  })
  const fullOf = new Map(names.map((full) => [basename(full), full]))
  return byLayout(bytes, images, async (image) => {
    const full = fullOf.get(image.name)!
    const entry = opened.cfb.FileIndex[opened.cfb.FullPaths.indexOf(full)]
    const stored = new Uint8Array((entry?.content ?? []) as Uint8Array)
    return pictureMime(stored)
      ? stored
      : new Uint8Array(inflateRawSync(stored, { maxOutputLength: MAX_IMAGE + 1 }))
  })
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

/**
 * Where the pages of a Word body begin, as positions in its XML. Word writes down each page it
 * laid out (`w:lastRenderedPageBreak`), so those are exact. Without them only the hard page breaks
 * are left, and a page counted from them is a lower bound. A body with neither says nothing about
 * its pages, and a page is not guessed.
 */
function pageStarts(xml: string): { at: number[]; approx: boolean } | null {
  const rendered = [...xml.matchAll(/<(?:\w+:)?lastRenderedPageBreak\b/g)].map((m) => m.index!)
  if (rendered.length) return { at: rendered, approx: false }
  const hard = [
    ...xml.matchAll(/<(?:\w+:)?br\b[^>]*\btype\s*=\s*["']page["'][^>]*>/g),
    ...xml.matchAll(
      /<(?:\w+:)?pageBreakBefore\b(?![^>]*\bval\s*=\s*["'](?:0|false|off)["'])[^>]*>/g,
    ),
  ]
    .map((m) => m.index!)
    .sort((a, b) => a - b)
  return hard.length ? { at: hard, approx: true } : null
}

/** Enumerate content references, never the media folder or external targets. */
export async function listEmbeddedImages(path: string): Promise<EmbeddedImage[]> {
  if (!supportsEmbeddedOcr(path) && !supportsExtractedOcr(path))
    throw new Error('only DOCX, XLSX, HWPX and HWP pictures can be listed')
  if (extname(path).toLowerCase() === '.hwp') return listHwpImages(path)
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
    const add = async (
      part: string,
      id: string,
      location: string,
      boxable = false,
      page?: { number: number; approx: boolean },
    ) => {
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
        ...(page
          ? { page: page.number, ...(page.approx ? { pageApprox: true as const } : {}) }
          : {}),
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
        const styles = (await text('word/styles.xml')) || undefined
        let paragraph = 0
        // only the body has pages of its own; a header or note part repeats or floats
        const starts = part === 'word/document.xml' ? pageStarts(xml) : null
        for (const m of xml.matchAll(/<(?:\w+:)?(p|blip|imagedata|fill)\b[^>]*>/g)) {
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
              m[1] === 'blip' && inspectBoxableImage(part, raw, at, id, styles).ok,
              starts
                ? {
                    number: 1 + starts.at.filter((position) => position < m.index!).length,
                    approx: starts.approx,
                  }
                : undefined,
            )
          }
        }
      }
    } else if (extname(path).toLowerCase() === '.hwpx') {
      // the manifest maps an item id to a BinData file; the sections (body, tables, headers) and
      // header.xml (background and fill pictures) name the items they use
      const hrefById = new Map<string, string>()
      for (const m of (await text('Contents/content.hpf')).matchAll(/<(?:\w+:)?item\b[^>]*>/g)) {
        const a = attrs(m[0])
        if (a.id && a.href) hrefById.set(a.id, target('', a.href))
      }
      const parts = [...entries.keys()]
        .filter((n) => /^Contents\/section\d+\.xml$/.test(n))
        .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      if (entries.has('Contents/header.xml')) parts.push('Contents/header.xml')
      for (const part of parts)
        for (const m of (await text(part)).matchAll(/binaryItemIDRef\s*=\s*"([^"]*)"/g)) {
          const id = decodeEntities(m[1]!)
          const href = hrefById.get(id)
          const entry = href ? entries.get(href) : undefined
          if (!href || !entry || entry.usize === 0 || seen.has(href)) continue
          if (!/\.(png|jpe?g)$/i.test(href)) continue
          seen.add(href)
          images.push({
            name: basename(href),
            location: basename(part),
            entry,
            signature: src.signature,
            part,
            relId: id,
          })
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
    if (extname(path).toLowerCase() === '.hwpx')
      return await byLayout(
        new Uint8Array(await src.bytes.read(0, src.bytes.size)),
        images,
        async (image) => new Uint8Array(await readPart(src.bytes, image.entry!, MAX_IMAGE)),
      )
    return images
  } finally {
    await src.handle.close()
  }
}

/** A file larger than this is not laid out for its pages: the engine would hold up the app. */
const MAX_LAYOUT_BYTES = 30 * 1024 * 1024

/**
 * Put the pictures of a Hangul document in the order of its pages and give each its page, from
 * the engine's own layout. Whatever goes wrong (a file the engine cannot lay out, one that is
 * too large) leaves the pictures as stored and without pages: the listing never fails for it.
 */
async function byLayout(
  documentBytes: Uint8Array,
  images: EmbeddedImage[],
  bytesOf: (image: EmbeddedImage) => Promise<Uint8Array>,
): Promise<EmbeddedImage[]> {
  if (images.length === 0 || documentBytes.length > MAX_LAYOUT_BYTES) return images
  try {
    const places = await hwpPicturePlaces(documentBytes)
    if (places.length === 0) return images
    const hashes: string[] = []
    for (const image of images)
      hashes.push(
        createHash('sha256')
          .update(await bytesOf(image))
          .digest('hex'),
      )
    return orderByPlaces(images, hashes, places).map(({ image, page }) =>
      page === undefined ? image : { ...image, page },
    )
  } catch {
    return images
  }
}

/** Read a descriptor from the same source version that was listed. */
export async function readEmbeddedImage(path: string, image: EmbeddedImage): Promise<OcrPageImage> {
  const src = await source(path)
  try {
    if (image.read) return await image.read()
    if (src.signature !== image.signature) throw new Error('OCR source changed after listing')
    if (!image.entry) throw new Error('this picture has no package part to read')
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
