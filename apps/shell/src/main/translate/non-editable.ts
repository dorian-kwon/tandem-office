import { mkdir, rm } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import type { Lang } from '@genoffice/i18n'
import {
  loadProject,
  setSourceKind,
  verifySource,
  type SourceEntry,
} from '@genoffice/translate-project'
import type { ResultStore } from '../../../../../packages/pdf-structure/src/store'
import type {
  JobRecordInput,
  TranslationBlockInput,
} from '../../../../../packages/pdf-structure/src/store/store'
import type { DocumentTree } from '../../../../../packages/pdf-structure/src/tree/types'
import { withoutImageData } from '../pdf-structure/handlers'
import { TranslateIpcError } from '../../shared/translate-api'
import {
  pdfTranslationTargetOf,
  UnsupportedTargetLanguageError,
  type TranslatePdfPrepared,
  type TranslatePdfStoreAnswer,
  type TranslatePdfWritten,
} from '../../shared/translate-pdf'
import { placeNewFile, temporaryPath } from './output-file'

/**
 * Translation of the sources no editor can change (spec 6.4): a PDF with a
 * text layer, a scanned PDF and an image.
 *
 * - Scan detection: a PDF source is checked for a text layer when it is
 *   first opened; a scan is recorded in project.json.
 * - A text PDF is translated by the PDF editor's translation engine. The AI
 *   calls run in the home screen over the shared `ai:stream` channel
 *   (shared/translate-pdf.ts), as every AI request of the app does; this
 *   module reads the document tree, keeps the result store calls to that one
 *   document and language, and writes the translated PDF into output/ under
 *   a new name with the engine's own writer (a structure job).
 * - A scan or an image goes through the OCR window (ocr.ts) into a Word
 *   document that is then translated in the Word editor.
 *
 * Nothing here logs document text.
 */

/** a page with fewer characters than this in its text layer counts as a picture of a page */
export const SCAN_MIN_TEXT_CHARS = 20

/** share of such pages from which the whole PDF is read as a scan */
export const SCAN_PAGE_SHARE = 0.5

/**
 * "Most pages have no text layer": at least SCAN_PAGE_SHARE (half) of the
 * pages hold fewer than SCAN_MIN_TEXT_CHARS characters. Half, not more than
 * half, because the text engine leaves a scanned page untranslated: a PDF
 * that is half scans is better read by OCR. No pages: not a scan.
 */
export function isMostlyScanned(counts: readonly number[]): boolean {
  if (counts.length === 0) return false
  const pictures = counts.filter((n) => n < SCAN_MIN_TEXT_CHARS).length
  return pictures / counts.length >= SCAN_PAGE_SHARE
}

export interface ScanDetectDeps {
  /** characters in each page's text layer (a structure job in the app) */
  pageTextCounts(pdfPath: string): Promise<number[]>
}

/** true when most pages of the PDF have no text layer (isMostlyScanned) */
export async function detectScan(pdfPath: string, deps: ScanDetectDeps): Promise<boolean> {
  return isMostlyScanned(await deps.pageTextCounts(pdfPath))
}

// ---- routing and the text-PDF translation job (main side) ----

/** idle time after which a translation token is dropped and frees its project */
export const PDF_TRANSLATE_IDLE_MS = 30 * 60_000

/** translated blocks one store call may carry (a batch is far smaller) */
const MAX_BLOCKS_PER_CALL = 10_000
const MAX_TEXT = 200

export interface NonEditableDeps extends ScanDetectDeps {
  /** the document tree of a PDF and its content hash (a structure job in the app) */
  pdfTree(pdfPath: string): Promise<{ docHash: string; tree: DocumentTree }>
  /** write the translated PDF of what is stored for that hash into `outPath` (a structure job) */
  writeTranslatedPdf(
    pdfPath: string,
    outPath: string,
    payload: { lang: string; bilingual?: true },
  ): Promise<void>
  /** the result store the PDF editor's translations live in */
  store(): Pick<
    ResultStore,
    | 'readTranslation'
    | 'writeTranslationMeta'
    | 'writeTranslationBlocks'
    | 'deleteTranslation'
    | 'deleteTranslationExceptEdited'
    | 'writeJob'
  >
}

interface PdfLease {
  token: string
  key: string
  dir: string
  /** the source copy in source/ */
  path: string
  stem: string
  docHash: string
  lang: Lang
  owner: number | null
  /** a store write happened: the job runs, the project is busy */
  running: boolean
  touched: number
}

const invalid = (text: string) => new TranslateIpcError('INVALID_ARGUMENT', text)

function fold(path: string): string {
  const full = resolve(path)
  return process.platform === 'win32' ? full.toLowerCase() : full
}

export function plainFileName(file: unknown): file is string {
  return (
    typeof file === 'string' &&
    file !== '' &&
    file !== '.' &&
    file !== '..' &&
    basename(file) === file &&
    !/[\\/]/.test(file) &&
    !file.includes('\0')
  )
}

export function stemOf(file: string): string {
  const ext = extname(file)
  return file.slice(0, file.length - ext.length) || file
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function blockInputOf(v: unknown): TranslationBlockInput | null {
  if (!isRecord(v) || !isRecord(v.key)) return null
  const { pageFingerprint, textHash, occurrence } = v.key
  if (typeof pageFingerprint !== 'string' || typeof textHash !== 'string') return null
  if (!Number.isSafeInteger(occurrence) || (occurrence as number) < 0) return null
  if (v.status !== 'translated' && v.status !== 'failed') return null
  if (v.status === 'translated' && typeof v.text !== 'string') return null
  if (v.status === 'failed' && typeof v.reason !== 'string') return null
  return v as unknown as TranslationBlockInput
}

export function createNonEditableService(
  deps: NonEditableDeps,
  now: () => number,
  newToken: () => string,
) {
  const leases = new Map<string, PdfLease>()
  /** scan answers per source copy (folder, name, hash): one detection per copy and run */
  const detected = new Map<string, boolean>()

  function sweep(): void {
    const at = now()
    for (const [token, l] of leases)
      if (at - l.touched > PDF_TRANSLATE_IDLE_MS) leases.delete(token)
  }

  function lease(token: unknown): PdfLease {
    sweep()
    const found = typeof token === 'string' ? leases.get(token) : undefined
    if (!found)
      throw new TranslateIpcError('TRANSLATE_EXPIRED', 'this translation has ended; start it again')
    found.touched = now()
    return found
  }

  /**
   * The kind to open a source as. A PDF is checked for a text layer the
   * first time it is opened; a scan is recorded in project.json ('pdf' →
   * 'scan'). A 'scan' entry is never turned back into 'pdf' here. A
   * detection that fails (a password, a damaged file) changes nothing.
   */
  async function resolveKind(dir: string, entry: SourceEntry): Promise<SourceEntry> {
    if (entry.kind !== 'pdf' || !plainFileName(entry.file)) return entry
    const key = `${fold(dir)}\0${entry.file}\0${entry.sha256}`
    let scan = detected.get(key)
    if (scan === undefined) {
      try {
        scan = await detectScan(join(dir, 'source', entry.file), deps)
      } catch {
        return entry
      }
      detected.set(key, scan)
    }
    if (!scan) return entry
    await setSourceKind(dir, entry.file, 'scan')
    return { ...entry, kind: 'scan' }
  }

  return {
    resolveKind,

    /** read the tree of a registered project's text PDF under a new token */
    async pdfPrepare(dir: string, file: unknown, owner?: number): Promise<TranslatePdfPrepared> {
      sweep()
      if (!plainFileName(file)) throw invalid('the file name is not valid')
      const project = await loadProject(dir)
      const listed = project.sources.find((s) => s.file === file)
      if (!listed) throw new TranslateIpcError('NOT_LISTED', 'this document is not in the project')
      const entry = await resolveKind(dir, listed)
      if (entry.kind !== 'pdf')
        throw new TranslateIpcError(
          'UNSUPPORTED_SOURCE',
          'only a PDF with a text layer is translated this way',
        )
      const lang = pdfTranslationTargetOf(project.targetLang)
      if (!lang) throw new UnsupportedTargetLanguageError(project.targetLang)
      if ((await verifySource(dir, entry)) === 'missing')
        throw new TranslateIpcError('SOURCE_MISSING', 'the copy in the source folder is missing')
      const key = fold(dir)
      for (const l of leases.values())
        if (l.key === key && l.running)
          throw new TranslateIpcError('TRANSLATE_BUSY', 'a translation runs for this project')
      // an earlier preparation of this project that never ran is replaced
      for (const [token, l] of leases) if (l.key === key) leases.delete(token)
      const path = join(dir, 'source', entry.file)
      let read: { docHash: string; tree: DocumentTree }
      try {
        read = await deps.pdfTree(path)
      } catch (err) {
        if (err instanceof TranslateIpcError) throw err
        throw new TranslateIpcError('TRANSLATE_FAILED', 'the PDF could not be read')
      }
      const token = newToken()
      leases.set(token, {
        token,
        key,
        dir,
        path,
        stem: stemOf(entry.file),
        docHash: read.docHash,
        lang,
        owner: owner ?? null,
        running: false,
        touched: now(),
      })
      return { token, lang, docHash: read.docHash, tree: withoutImageData(read.tree) }
    },

    /** one result-store call of the job: always this token's document and language */
    async pdfStore(token: unknown, request: unknown): Promise<TranslatePdfStoreAnswer> {
      const l = lease(token)
      if (!isRecord(request)) throw invalid('the store request is not valid')
      const store = deps.store()
      const write = () => {
        l.running = true
      }
      switch (request.op) {
        case 'read': {
          const t = await store.readTranslation(l.docHash, l.lang)
          return {
            translation: t && {
              lang: t.lang,
              provider: t.provider,
              model: t.model,
              blocks: [...t.blocks.values()],
            },
          }
        }
        case 'meta': {
          const { provider, model } = request
          if (typeof provider !== 'string' || provider.length > MAX_TEXT) break
          if (typeof model !== 'string' || model.length > MAX_TEXT) break
          write()
          await store.writeTranslationMeta(l.docHash, l.lang, { provider, model })
          return {}
        }
        case 'blocks': {
          const blocks = request.blocks
          if (!Array.isArray(blocks) || blocks.length > MAX_BLOCKS_PER_CALL) break
          const checked = blocks.map(blockInputOf)
          if (checked.some((b) => b === null)) break
          write()
          await store.writeTranslationBlocks(l.docHash, l.lang, checked as TranslationBlockInput[])
          return {}
        }
        case 'delete':
          write()
          await store.deleteTranslation(l.docHash, l.lang)
          return {}
        case 'delete-except-edited':
          write()
          return { removed: await store.deleteTranslationExceptEdited(l.docHash, l.lang) }
        case 'job': {
          const job = request.job
          // the record of this document's translation into this language, nothing else
          if (!isRecord(job) || job.kind !== 'translate' || job.lang !== l.lang) break
          write()
          await store.writeJob(l.docHash, job as unknown as JobRecordInput)
          return {}
        }
      }
      throw invalid('the store request is not valid')
    },

    /**
     * Write the translated PDF (`<stem>.<lang>.pdf`, or `.bilingual.pdf`)
     * from what is stored into output/ under a new name, and end the token.
     */
    async pdfWrite(token: unknown, bilingual: unknown): Promise<TranslatePdfWritten> {
      const l = lease(token)
      if (typeof bilingual !== 'boolean') throw invalid('bilingual must be true or false')
      const outputDir = join(l.dir, 'output')
      await mkdir(outputDir, { recursive: true })
      const tmp = temporaryPath(outputDir, '.pdf')
      try {
        await deps.writeTranslatedPdf(l.path, tmp, {
          lang: l.lang,
          ...(bilingual ? { bilingual: true as const } : {}),
        })
      } catch (err) {
        await rm(tmp, { force: true }).catch(() => undefined)
        if (err instanceof TranslateIpcError) throw err
        throw new TranslateIpcError('TRANSLATE_FAILED', 'the translated PDF could not be written')
      }
      const stem = `${l.stem}.${l.lang}${bilingual ? '.bilingual' : ''}`
      const output = await placeNewFile(outputDir, stem, '.pdf', tmp)
      leases.delete(l.token)
      return { output }
    },

    async pdfRelease(token: unknown): Promise<void> {
      if (typeof token === 'string') leases.delete(token)
    },

    /** the window went away: its translations end with it */
    forgetOwner(owner: number): void {
      for (const [token, l] of leases) if (l.owner === owner) leases.delete(token)
    },
  }
}

export type NonEditableService = ReturnType<typeof createNonEditableService>
