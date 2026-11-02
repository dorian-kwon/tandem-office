import { constants } from 'node:fs'
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
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
} from '../../shared/translate-ocr'
import { TranslateIpcError } from '../../shared/translate-api'

/**
 * The main-process half of the translation OCR (spec 6.5). The renderer runs
 * `runOcr` (shared/translate-ocr.ts): the AI calls go over the shared
 * `ai:stream` channel like every other AI request of the app, under the same
 * provider choice and send gate. This module only
 *
 * - lists what can be read (a scanned PDF's pages, or image files) under a
 *   token, for a registered project whose OCR is on;
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

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg']

export interface OcrServiceDeps {
  /** page count of a PDF (a structure job in the app) */
  pdfPageCount(path: string): Promise<number>
  /** one 1-based page of a PDF as PNG bytes (a structure job in the app) */
  renderPdfPage(path: string, page: number): Promise<Uint8Array>
  /** Markdown → .docx bytes (the bundled CLI's converter in the app) */
  markdownToDocx(markdown: string): Promise<Uint8Array>
}

interface Lease {
  token: string
  /** folded project folder, for the one-run-per-project rule */
  key: string
  dir: string
  kind: 'pdf' | 'images'
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
      if (entries.some((e) => e.kind === 'editable'))
        throw new TranslateIpcError(
          'SOURCE_NOT_EDITABLE',
          'an editable document is translated in its editor, not read by OCR',
        )
      if (entries.some(isPdf) && entries.length > 1)
        throw invalid('a PDF is read on its own, not together with other files')
      for (const e of entries) {
        if (e.kind === 'image' && !IMAGE_EXTENSIONS.includes(extname(e.file).toLowerCase()))
          throw new TranslateIpcError('UNSUPPORTED_SOURCE', 'only PNG and JPEG images can be read')
        if ((await verifySource(dir, e)) === 'missing')
          throw new TranslateIpcError('SOURCE_MISSING', 'the copy in the source folder is missing')
      }
      const key = fold(dir)
      if (runningFor(key))
        throw new TranslateIpcError('OCR_BUSY', 'OCR is already running for this project')
      // an earlier listing of this project that never started is replaced
      for (const [token, l] of leases) if (l.key === key) leases.delete(token)

      const paths = entries.map((e) => join(dir, 'source', e.file))
      const kind = isPdf(entries[0]!) ? 'pdf' : 'images'
      const count = kind === 'pdf' ? await deps.pdfPageCount(paths[0]!) : entries.length
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
        items:
          kind === 'pdf'
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
      l.selection = new Set(chosen)
    },

    async pageImage(token: unknown, index: unknown): Promise<OcrPageImage> {
      const l = lease(token)
      if (l.selection === null || typeof index !== 'number' || !l.selection.has(index))
        throw invalid('only a confirmed page can be read')
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

    async write(token: unknown, pages: unknown): Promise<OcrWritten> {
      const l = lease(token)
      if (l.selection === null) throw invalid('this OCR run has not started')
      if (!Array.isArray(pages) || pages.length === 0 || pages.length > l.selection.size)
        throw invalid('there is no reading to write')
      const seen = new Set<number>()
      const readings = (pages as OcrPageResult[])
        .map((p) => {
          const index = (p as { index?: unknown } | null)?.index
          if (typeof index !== 'number' || !l.selection!.has(index) || seen.has(index))
            throw invalid('a reading is for a page that was not confirmed')
          seen.add(index)
          // the renderer's copy is checked by the engine's own payload reader
          const payload = readAiReadPayload(p.payload)
          if (!payload) throw invalid('a reading is not in the expected form')
          return materializeReading(payload, index, '')
        })
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
      const docx = await deps.markdownToDocx(treeToMarkdown(tree).markdown)
      const docxPath = await writeNew(join(l.dir, 'output'), `${l.stem} (OCR)`, '.docx', docx)
      leases.delete(l.token)
      return { docxPath }
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

/**
 * Write `bytes` as `<stem><ext>` in `dir`, or `<stem> (2)<ext>`, … when that
 * name is taken: the bytes go to a temporary file first and are copied under
 * the final name with an exclusive copy, so an existing file is never
 * replaced and a half-written file never carries the final name.
 */
async function writeNew(
  dir: string,
  stem: string,
  ext: string,
  bytes: Uint8Array,
): Promise<string> {
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `.ocr-${randomBytes(6).toString('hex')}.tmp`)
  await writeFile(tmp, bytes, { flag: 'wx' })
  try {
    for (let n = 1; n <= 1000; n++) {
      const path = join(dir, n === 1 ? `${stem}${ext}` : `${stem} (${n})${ext}`)
      try {
        await copyFile(tmp, path, constants.COPYFILE_EXCL)
        return path
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      }
    }
    throw new TranslateIpcError('OCR_FAILED', 'no free file name in the output folder')
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined)
  }
}
