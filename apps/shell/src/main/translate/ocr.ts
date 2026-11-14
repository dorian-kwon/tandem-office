import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import {
  IMAGE_SOURCE_EXTENSIONS,
  loadProject,
  verifySource,
  type OcrMode,
  type SourceEntry,
} from '@genoffice/translate-project'
import {
  materializeReading,
  readAiReadPayload,
  treeToMarkdown,
  type DocumentTree,
} from '../../../../../packages/pdf-structure/src'
import {
  OCR_MAX_ITEMS,
  resolveOcrSelection,
  type OcrPageImage,
  type OcrPageResult,
  type OcrPrepared,
  type OcrWritten,
  type OcrPlacement,
} from '../../shared/translate-ocr'
import { TranslateIpcError } from '../../shared/translate-api'
import { checkOcrBoxesPayload, type OcrBoxesPayload } from '../../shared/ocr-boxes'
import { writeNewFile } from './output-file'
import {
  listEmbeddedImages,
  readEmbeddedImage,
  supportsEmbeddedOcr,
  type EmbeddedImage,
} from './embedded-images'
import { imageSize } from '../../../../../packages/cli/src/formats/image-size'
import { ocrSheetNames, ocrWordTables, placeOcrText } from './ocr-placement'
import { recommendOcrPlacement } from './ocr-recommendation'

/**
 * The main-process half of the translation OCR (spec 6.5). The renderer runs
 * `runOcr` (shared/translate-ocr.ts): the AI calls go over the shared
 * `ai:stream` channel like every other AI request of the app, under the same
 * provider choice and send gate. This module only
 *
 * - lists what can be read (PDF pages, standalone or embedded images) under a
 *   token, for a registered project whose OCR is on;
 * - serves bounded local thumbnails for the embedded-image selection list;
 * - after the person confirmed, fixes the selection and serves those page
 *   images and nothing else;
 * - writes the readings, checked again by the engine's payload reader, into a
 *   new Word document in `output/` (Markdown from the engine's writer, then
 *   the app's Markdown → .docx conversion), never overwriting a file.
 *
 * One OCR run per project at a time. Nothing here logs page images or text.
 */

/** an image file larger than this is not sent (a photo of a page is far smaller) */
export const OCR_MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** a token nobody used for this long is dropped and no longer blocks its project */
export const OCR_LEASE_IDLE_MS = 30 * 60_000

/** the image types the OCR reads: the project's image sources (PNG, JPEG) */
const IMAGE_EXTENSIONS = IMAGE_SOURCE_EXTENSIONS.map((ext) => `.${ext}`)

export interface OcrServiceDeps {
  /** page count of a PDF (a structure job in the app) */
  pdfPageCount(path: string): Promise<number>
  /** one 1-based page of a PDF as PNG bytes (a structure job in the app) */
  renderPdfPage(path: string, page: number): Promise<Uint8Array>
  /** Markdown → .docx bytes (the bundled CLI's converter in the app) */
  markdownToDocx(markdown: string): Promise<Uint8Array>
  /** Local preview only; the original image is never returned by the preview endpoint. */
  thumbnail?(image: Uint8Array): Uint8Array | null
  /** Local enlarged preview (JPEG bytes, downscaled to fit the cap); same rules as `thumbnail`. */
  largePreview?(image: Uint8Array): Uint8Array | null
}

/** the most bytes the enlarged local preview may carry over the bridge */
export const OCR_LARGE_PREVIEW_MAX_BYTES = 2 * 1024 * 1024

interface Lease {
  token: string
  /** folded project folder, for the one-run-per-project rule */
  key: string
  dir: string
  kind: OcrPrepared['kind']
  embedded?: EmbeddedImage[]
  source?: SourceEntry
  /** source/ paths: the PDF, or the images in item order */
  paths: string[]
  count: number
  /** the stem the output file is named after */
  stem: string
  /** the project's OCR choice when listed; the run starts only while it still holds */
  ocr: Extract<OcrMode, { kind: 'ai' }>
  /** the webContents that listed it; its leases go when it goes */
  owner: number | null
  /** null until the person confirmed */
  selection: Set<number> | null
  touched: number
}

function fold(path: string): string {
  const full = resolve(path)
  return process.platform === 'win32' ? full.toLowerCase() : full
}

function plainFileName(file: unknown): file is string {
  return (
    typeof file === 'string' &&
    file !== '' &&
    file !== '.' &&
    file !== '..' &&
    basename(file) === file &&
    !/[\\/]/.test(file)
  )
}

function imageMime(bytes: Uint8Array): OcrPageImage['mime'] | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e)
    return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg'
  return null
}

const invalid = (text: string) => new TranslateIpcError('INVALID_ARGUMENT', text)

async function embeddedPath(dir: string, entry: SourceEntry): Promise<string> {
  const path = join(dir, 'source', entry.file)
  const [root, file, folder, actual] = await Promise.all([
    realpath(dir),
    lstat(path),
    lstat(join(dir, 'source')),
    realpath(path),
  ])
  if (
    !file.isFile() ||
    file.isSymbolicLink() ||
    folder.isSymbolicLink() ||
    !actual.startsWith(join(root, 'source') + sep)
  )
    throw new TranslateIpcError(
      'UNSUPPORTED_SOURCE',
      'the OCR source must be a regular project file',
    )
  return path
}

export function createOcrService(deps: OcrServiceDeps, now: () => number, newToken: () => string) {
  const leases = new Map<string, Lease>()

  function sweep(): void {
    const at = now()
    for (const [token, lease] of leases)
      if (at - lease.touched > OCR_LEASE_IDLE_MS) leases.delete(token)
  }

  function lease(token: unknown): Lease {
    sweep()
    const found = typeof token === 'string' ? leases.get(token) : undefined
    if (!found)
      throw new TranslateIpcError('OCR_EXPIRED', 'this OCR listing has ended; open it again')
    found.touched = now()
    return found
  }

  function runningFor(key: string, except?: string): Lease | undefined {
    for (const l of leases.values())
      if (l.key === key && l.selection !== null && l.token !== except) return l
    return undefined
  }

  /** the project's source entries for `files`, checked against project.json */
  function entriesOf(sources: SourceEntry[], files: unknown): SourceEntry[] {
    if (!Array.isArray(files) || files.length === 0 || files.length > OCR_MAX_ITEMS)
      throw invalid('choose one PDF or one or more images')
    const seen = new Set<string>()
    return files.map((file) => {
      if (!plainFileName(file)) throw invalid('a file name is not valid')
      if (seen.has(file)) throw invalid('a file is listed twice')
      seen.add(file)
      const entry = sources.find((s) => s.file === file)
      if (!entry) throw new TranslateIpcError('NOT_LISTED', 'this document is not in the project')
      return entry
    })
  }

  return {
    /** list the items (dir must already be a registered project) */
    async prepare(dir: string, files: unknown, owner?: number): Promise<OcrPrepared> {
      sweep()
      const project = await loadProject(dir)
      const ocr = project.ocr
      if (ocr.kind !== 'ai')
        throw new TranslateIpcError('OCR_DISABLED', 'OCR is switched off for this project')
      const entries = entriesOf(project.sources, files)
      const isPdf = (e: SourceEntry) => e.kind === 'pdf' || e.kind === 'scan'
      const editable = entries.some((e) => e.kind === 'editable')
      if (entries.some((e) => e.kind === 'editable' && !supportsEmbeddedOcr(e.file)))
        throw new TranslateIpcError(
          'SOURCE_NOT_EDITABLE',
          'an editable document is translated in its editor, not read by OCR',
        )
      if ((entries.some(isPdf) || editable) && entries.length > 1)
        throw invalid('a PDF is read on its own, not together with other files')
      for (const e of entries) {
        if (e.kind === 'editable') await embeddedPath(dir, e)
        if (e.kind === 'image' && !IMAGE_EXTENSIONS.includes(extname(e.file).toLowerCase()))
          throw new TranslateIpcError('UNSUPPORTED_SOURCE', 'only PNG and JPEG images can be read')
        const status = await verifySource(dir, e)
        if (status === 'missing')
          throw new TranslateIpcError('SOURCE_MISSING', 'the copy in the source folder is missing')
        if (editable && status !== 'ok')
          throw new TranslateIpcError('SOURCE_CHANGED', 'the OCR source changed; import it again')
      }
      const key = fold(dir)
      if (runningFor(key))
        throw new TranslateIpcError('OCR_BUSY', 'OCR is already running for this project')
      // an earlier listing of this project that never started is replaced
      for (const [token, l] of leases) if (l.key === key) leases.delete(token)

      const paths = entries.map((e) => join(dir, 'source', e.file))
      const kind = editable ? 'embedded' : isPdf(entries[0]!) ? 'pdf' : 'images'
      const embedded = editable
        ? await listEmbeddedImages(paths[0]!).catch(() => {
            throw new TranslateIpcError('OCR_FAILED', 'the document images could not be listed')
          })
        : undefined
      const count =
        kind === 'pdf' ? await deps.pdfPageCount(paths[0]!) : (embedded?.length ?? entries.length)
      if (!Number.isInteger(count) || count < 1)
        throw new TranslateIpcError('OCR_FAILED', 'the document has no pages to read')
      if (count > OCR_MAX_ITEMS)
        throw invalid(`a document of more than ${OCR_MAX_ITEMS} pages cannot be read at once`)
      const first = entries[0]!.file
      const token = newToken()
      leases.set(token, {
        token,
        key,
        dir,
        kind,
        paths,
        embedded,
        source: editable ? entries[0] : undefined,
        count,
        stem: first.slice(0, first.length - extname(first).length) || first,
        ocr,
        owner: owner ?? null,
        selection: null,
        touched: now(),
      })
      return {
        token,
        kind,
        ocr: project.ocr,
        ...(editable
          ? {
              format:
                extname(first).toLowerCase() === '.xlsx' ? ('xlsx' as const) : ('docx' as const),
              ...(extname(first).toLowerCase() === '.xlsx'
                ? { sheets: await ocrSheetNames(await readFile(paths[0]!)) }
                : { tables: await ocrWordTables(await readFile(paths[0]!)) }),
            }
          : {}),
        items: embedded
          ? embedded.map((image, i) => ({
              index: i + 1,
              name: image.name,
              location: image.location,
            }))
          : kind === 'pdf'
            ? Array.from({ length: count }, (_, i) => ({ index: i + 1, name: '' }))
            : entries.map((e, i) => ({ index: i + 1, name: e.file })),
      }
    },

    async start(token: unknown, pages: unknown): Promise<void> {
      const l = lease(token)
      if (l.selection !== null) throw invalid('this OCR run has already started')
      const chosen = resolveOcrSelection({ kind: 'pages', pages }, l.count)
      if (runningFor(l.key, l.token))
        throw new TranslateIpcError('OCR_BUSY', 'OCR is already running for this project')
      // the listing may be old: the OCR choice must still be the one the person confirmed.
      // A failed check ends the lease, so no page of it is ever served.
      const ocr = await loadProject(l.dir)
        .then((p) => p.ocr)
        .catch(() => null)
      if (!leases.has(l.token))
        throw new TranslateIpcError('OCR_EXPIRED', 'this OCR listing has ended')
      if (!ocr || ocr.kind !== 'ai') {
        leases.delete(l.token)
        throw new TranslateIpcError('OCR_DISABLED', 'OCR is switched off for this project')
      }
      if (ocr.provider !== l.ocr.provider) {
        leases.delete(l.token)
        throw new TranslateIpcError(
          'OCR_EXPIRED',
          'the OCR setting of this project changed; open the OCR window again',
        )
      }
      if (runningFor(l.key, l.token))
        throw new TranslateIpcError('OCR_BUSY', 'OCR is already running for this project')
      if (l.source) {
        await embeddedPath(l.dir, l.source)
        if ((await verifySource(l.dir, l.source)) !== 'ok') {
          leases.delete(l.token)
          throw new TranslateIpcError('SOURCE_CHANGED', 'the OCR source changed; open it again')
        }
      }
      l.selection = new Set(chosen)
    },

    /** Local thumbnails may be viewed before confirmation; original bytes remain gated. */
    async preview(token: unknown, index: unknown): Promise<OcrPageImage | null> {
      const l = lease(token)
      if (
        l.kind !== 'embedded' ||
        !Number.isInteger(index) ||
        (index as number) < 1 ||
        (index as number) > l.count
      )
        throw invalid('this item has no embedded preview')
      if (!deps.thumbnail) return null
      await embeddedPath(l.dir, l.source!)
      const image = await readEmbeddedImage(l.paths[0]!, l.embedded![(index as number) - 1]!)
      // Inspect headers before the native decoder allocates a pixel buffer.
      const size = imageSize(image.data)
      if (!size || size.width * size.height > 16_000_000) return null
      const data = deps.thumbnail(image.data)
      if (!data || data.length > 64 * 1024) return null
      return { data, mime: 'image/png' }
    },

    /**
     * A larger local preview for looking at one picture closely. Same rules as the thumbnail
     * (listed lease, embedded only, header checked before decoding, never the AI input), with a
     * 2 MB cap on what is returned. Nothing here starts a run or reaches a provider.
     */
    async previewLarge(token: unknown, index: unknown): Promise<OcrPageImage | null> {
      const l = lease(token)
      if (
        l.kind !== 'embedded' ||
        !Number.isInteger(index) ||
        (index as number) < 1 ||
        (index as number) > l.count
      )
        throw invalid('this item has no embedded preview')
      if (!deps.largePreview) return null
      await embeddedPath(l.dir, l.source!)
      const image = await readEmbeddedImage(l.paths[0]!, l.embedded![(index as number) - 1]!)
      const size = imageSize(image.data)
      if (!size || size.width * size.height > 16_000_000) return null
      const data = deps.largePreview(image.data)
      if (!data || data.length === 0 || data.length > OCR_LARGE_PREVIEW_MAX_BYTES) return null
      return { data, mime: 'image/jpeg' }
    },

    async pageImage(token: unknown, index: unknown): Promise<OcrPageImage> {
      const l = lease(token)
      if (l.selection === null || typeof index !== 'number' || !l.selection.has(index))
        throw invalid('only a confirmed page can be read')
      if (l.kind === 'embedded') {
        await embeddedPath(l.dir, l.source!)
        return readEmbeddedImage(l.paths[0]!, l.embedded![index - 1]!).catch(() => {
          throw new TranslateIpcError(
            'SOURCE_CHANGED',
            'the OCR image changed or could not be read',
          )
        })
      }
      if (l.kind === 'pdf') {
        const data = await deps.renderPdfPage(l.paths[0]!, index)
        return { data, mime: 'image/png' }
      }
      const path = l.paths[index - 1]!
      const info = await stat(path).catch(() => null)
      if (!info?.isFile())
        throw new TranslateIpcError('SOURCE_MISSING', 'the copy in the source folder is missing')
      if (info.size > OCR_MAX_IMAGE_BYTES)
        throw new TranslateIpcError('UNSUPPORTED_SOURCE', 'the image is too large to send')
      const data = new Uint8Array(await readFile(path))
      const mime = imageMime(data)
      if (!mime)
        throw new TranslateIpcError('UNSUPPORTED_SOURCE', 'only PNG and JPEG images can be read')
      return { data, mime }
    },

    async recommend(token: unknown, pages: unknown) {
      const l = lease(token)
      if (l.kind !== 'embedded' || !l.selection) throw invalid('confirm the OCR selection first')
      const chosen = resolveOcrSelection({ kind: 'pages', pages }, l.count)
      if (chosen.some((index) => !l.selection!.has(index)))
        throw invalid('recommend only selected images')
      const path = await embeddedPath(l.dir, l.source!)
      if ((await verifySource(l.dir, l.source!)) !== 'ok')
        throw new TranslateIpcError('SOURCE_CHANGED', 'the OCR source changed')
      return recommendOcrPlacement(
        await readFile(path),
        extname(l.source!.file).toLowerCase() === '.xlsx' ? 'xlsx' : 'docx',
        chosen.map((index) => l.embedded![index - 1]!),
      )
    },

    async write(token: unknown, pages: unknown, placement?: OcrPlacement): Promise<OcrWritten> {
      const l = lease(token)
      if (l.selection === null) throw invalid('this OCR run has not started')
      if (!Array.isArray(pages) || pages.length === 0 || pages.length > l.selection.size)
        throw invalid('there is no reading to write')
      const seen = new Set<number>()
      // a box reading (embedded docx pictures) keeps its text and places; it has no document tree
      const boxReadings = new Map<number, OcrBoxesPayload>()
      const readings = (pages as OcrPageResult[])
        .map((p) => {
          const index = (p as { index?: unknown } | null)?.index
          if (typeof index !== 'number' || !l.selection!.has(index) || seen.has(index))
            throw invalid('a reading is for a page that was not confirmed')
          seen.add(index)
          const boxes = checkOcrBoxesPayload(p.payload)
          if (boxes) {
            if (l.kind !== 'embedded') throw invalid('a box reading is only for embedded pictures')
            boxReadings.set(index, boxes)
            return null
          }
          // the renderer's copy is checked by the engine's own payload reader
          const payload = readAiReadPayload(p.payload)
          if (!payload) throw invalid('a reading is not in the expected form')
          return materializeReading(payload, index, '')
        })
        .filter((reading): reading is NonNullable<typeof reading> => reading !== null)
        .sort((a, b) => a.page - b.page)

      const tree: DocumentTree = {
        version: 1,
        variant: 'original',
        info: { title: l.stem },
        sourcePageCount: l.count,
        pages: readings.map((r) => ({
          page: r.page,
          fingerprint: '',
          status: 'ai',
          widthPt: 0,
          heightPt: 0,
        })),
        blocks: readings.flatMap((r) => r.blocks),
        footnotes: readings.flatMap((r) => r.footnotes),
        outline: [],
        toc: [],
        footnoteLinkFailedPages: readings.filter((r) => r.footnoteLinkFailed).map((r) => r.page),
        warnings: [],
      }
      if (l.kind === 'embedded') {
        if (!placement) throw invalid('choose where the OCR text goes')
        const path = await embeddedPath(l.dir, l.source!)
        if ((await verifySource(l.dir, l.source!)) !== 'ok')
          throw new TranslateIpcError(
            'SOURCE_CHANGED',
            'the source changed before placing OCR text',
          )
        const format = extname(l.source!.file).toLowerCase() === '.xlsx' ? 'xlsx' : 'docx'
        const textOf = new Map(
          readings.map((r) => [
            r.page,
            treeToMarkdown({
              ...tree,
              pages: tree.pages.filter((p) => p.page === r.page),
              blocks: r.blocks,
              footnotes: r.footnotes,
            }).markdown,
          ]),
        )
        const items = [...seen]
          .sort((a, b) => a - b)
          .map((index) => ({
            index,
            location: l.embedded![index - 1]!.location,
            text: boxReadings.get(index)?.text ?? textOf.get(index) ?? '',
          }))
        const bytes = await placeOcrText(await readFile(path), format, items, placement)
        const outputPath = await writeNewFile(
          join(l.dir, 'output'),
          `${l.stem} (OCR)`,
          `.${format}`,
          bytes,
        )
        leases.delete(l.token)
        return { outputPath }
      }
      const docx = await deps.markdownToDocx(treeToMarkdown(tree).markdown)
      const outputPath = await writeNewFile(join(l.dir, 'output'), `${l.stem} (OCR)`, '.docx', docx)
      leases.delete(l.token)
      return { outputPath }
    },

    async release(token: unknown): Promise<void> {
      if (typeof token === 'string') leases.delete(token)
    },

    /** the webContents went away (closed, crashed): its listings and runs end with it */
    forgetOwner(owner: number): void {
      for (const [token, l] of leases) if (l.owner === owner) leases.delete(token)
    },
  }
}

export type OcrService = ReturnType<typeof createOcrService>
