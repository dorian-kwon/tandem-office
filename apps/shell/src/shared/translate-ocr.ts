import type { OcrMode, SourceEntry } from '@genoffice/translate-project'
import type { AiReadRequest } from '../../../../packages/pdf-structure/src/ai-read/instruction'
import { readAiPage } from '../../../../packages/pdf-structure/src/ai-read/read-page'
import { classifyRunError, isJobStopKind } from '../../../../packages/pdf-structure/src/jobs/errors'
import { readOcrBoxes, type OcrBox } from './ocr-boxes'

/**
 * OCR of a translation project's scanned PDF, standalone or embedded images through the
 * signed-in AI ("AI reading", spec 6.5). Environment-free: the renderer runs
 * it with the bridge (`translate:ocr-*`) and the shared `ai:stream` call, the
 * tests with fakes.
 *
 * Rules kept here:
 * - only what the person selected is read: a PDF's pages, or several image
 *   files by their position in the list (both 1-based);
 * - an empty selection, or OCR switched off for the project, ends before any
 *   AI call;
 * - `confirm` (the price and transfer confirmation) is asked with the count
 *   first; nothing is rendered or sent unless it answers true;
 * - every call goes to the provider of the project's OCR setting;
 * - the AI answer is document data only (the engine's reading instruction
 *   says so and its parser keeps only the transcription).
 */

/** which items to read: every one, or these 1-based positions */
export type OcrSelection = { kind: 'all' } | { kind: 'pages'; pages: number[] }

/** most items one OCR run may read (a sanity bound, far above a real document) */
export const OCR_MAX_ITEMS = 5000

/** calls one run keeps in flight (the document jobs' limit) */
export const OCR_CONCURRENCY = 2

/** failed items in a row after which the run stops */
export const OCR_MAX_FAILURES_IN_A_ROW = 3

export type OcrProvider = Extract<OcrMode, { kind: 'ai' }>['provider']

/** One readable item: a PDF page, standalone image or placed document image. */
export interface OcrItem {
  /** 1-based position */
  index: number
  /** PDF: '' (the screen says "page N"); images: the plain file name */
  name: string
  /** document part/paragraph or workbook sheet/cell; absent for standalone images */
  location?: string
  /** a docx picture whose text can go back over it as boxes (see ocr-boxes-docx); absent = no */
  boxable?: boolean
  /** the page the picture is on, when the file says so; absent = not known (a PDF item is its page) */
  page?: number
  /** `page` was counted from hard page breaks only, so the picture may be on a later page */
  pageApprox?: boolean
}

/** what `prepare` answers: the items to choose from, under a token main holds */
export interface OcrPrepared {
  token: string
  /** `extracted`: the pictures of a Hangul document, read into a new Word document with no placement step */
  kind: 'pdf' | 'images' | 'embedded' | 'extracted'
  ocr: OcrMode
  items: OcrItem[]
  format?: 'docx' | 'xlsx'
  sheets?: string[]
  tables?: OcrTable[]
}

export interface OcrPageImage {
  data: Uint8Array
  mime: 'image/png' | 'image/jpeg'
}

/** one item's reading as the engine's store payload (main checks it again) */
export interface OcrPageResult {
  index: number
  payload: unknown
}

export interface OcrWritten {
  /** The result in output/, keeping the editable source's format. */
  outputPath: string
}

export type OcrPlacement =
  | { kind: 'xlsx-cells'; sheet: string; cell: string; overwrite: boolean }
  | { kind: 'xlsx-new-sheet'; sheet: string }
  | { kind: 'docx-after-images' }
  | { kind: 'docx-before-images' }
  | { kind: 'docx-next-page' }
  | { kind: 'docx-replace-images' }
  | { kind: 'docx-end' }
  | { kind: 'docx-table-cell'; table: number; row: number; column: number; overwrite: boolean }
  | { kind: 'docx-image-boxes'; images: { index: number; boxes: OcrBox[] }[] }

export interface OcrTable {
  index: number
  rows: number
  columns: number
}

export interface OcrRecommendation {
  placement: OcrPlacement
  reason: 'empty-cells' | 'new-sheet' | 'after-images'
}

/** the bridge calls `runOcr` needs (window.translateApi in the app) */
export interface OcrBridge {
  prepare(dir: string, files: string[]): Promise<OcrPrepared>
  /** the person confirmed these items; main serves and accepts only them from now on */
  start(token: string, pages: number[]): Promise<void>
  pageImage(token: string, index: number): Promise<OcrPageImage>
  write(token: string, pages: OcrPageResult[], placement?: OcrPlacement): Promise<OcrWritten>
  release(token: string): Promise<void>
}

/** one model call to the project's OCR provider */
export type OcrAsk = (
  provider: OcrProvider,
  request: AiReadRequest,
  signal: AbortSignal,
) => Promise<string>

export interface OcrProgress {
  done: number
  total: number
  /** the item being read, when one is */
  current: number | null
}

export interface RunOcrArgs {
  /** the registered project folder */
  dir: string
  /** One PDF or DOCX/XLSX, or standalone images in reading order. */
  source: SourceEntry | readonly SourceEntry[]
  selection: OcrSelection
  /** the price and transfer confirmation; true sends, false sends nothing */
  confirm: (count: number) => Promise<boolean>
  bridge: OcrBridge
  ask: OcrAsk
  /** the listing the screen already holds; absent = prepared (and released) here */
  prepared?: OcrPrepared
  signal?: AbortSignal
  onProgress?: (progress: OcrProgress) => void
  /**
   * Read the `boxable` pictures of an embedded docx as boxes (text, place and text size in one
   * call, replacing their plain reading). Off for the chat popup, which only wants the text.
   */
  boxes?: boolean
  /** Required for embedded images: review the readings and explicitly choose their destination. */
  choosePlacement?: (pages: OcrPageResult[], error?: unknown) => Promise<OcrPlacement | null>
  /**
   * Called once the reading ended and before anything is handed on, with what each item did:
   * read, or failed with a reason. It also runs when nothing could be read.
   */
  onSettled?: (outcome: OcrSettled) => void
}

/** why one item gave no reading */
export interface OcrFailure {
  index: number
  /** malformed: answered but not in the required form; error: the call failed; stopped: never asked */
  reason: 'malformed' | 'error' | 'stopped'
  /** display-safe: no paths, no long secrets, bounded */
  message: string
}

export interface OcrSettled {
  read: number[]
  failures: OcrFailure[]
  stopped?: RunOcrResult['stopped']
}

/** The error text of a failed call as it may be shown: no absolute paths or tokens, bounded. */
export function safeOcrMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw
    .replace(/(?:[A-Za-z]:)?[\\/](?:[^\s\\/:"']+[\\/])+[^\s"']*/g, '…')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '…')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

export interface RunOcrResult extends OcrWritten {
  /** items read */
  read: number[]
  /** items that could not be read (two malformed answers, or a call that failed twice) */
  failed: number[]
  /** why the run ended early, when it did; the document holds what was read before */
  stopped?: 'cancelled' | 'failures' | 'connection'
}

export class EmptyOcrSelectionError extends Error {
  constructor() {
    super('no page or file is selected for OCR')
    this.name = 'EmptyOcrSelectionError'
  }
}

export class OcrDisabledError extends Error {
  constructor() {
    super('OCR is switched off for this project')
    this.name = 'OcrDisabledError'
  }
}

export class InvalidOcrSelectionError extends Error {
  constructor(text: string) {
    super(text)
    this.name = 'InvalidOcrSelectionError'
  }
}

export class OcrCancelledError extends Error {
  constructor(text = 'OCR was cancelled before anything was read') {
    super(text)
    this.name = 'OcrCancelledError'
  }
}

export class OcrFailedError extends Error {
  /** the run error kind of the call that ended it, when it had one */
  readonly kind?: string
  readonly resetsAt?: number
  constructor(text: string, cause?: { kind?: string; resetsAt?: number }) {
    super(text)
    this.name = 'OcrFailedError'
    if (cause?.kind !== undefined) this.kind = cause.kind
    if (cause?.resetsAt !== undefined) this.resetsAt = cause.resetsAt
  }
}

/**
 * The 1-based positions a selection names out of `count` items, ascending.
 * Rejects an empty selection, a position that is not an integer in range, a
 * repeated position and more than OCR_MAX_ITEMS positions.
 */
export function resolveOcrSelection(selection: unknown, count: number): number[] {
  if (!Number.isInteger(count) || count < 1 || count > OCR_MAX_ITEMS)
    throw new InvalidOcrSelectionError('there is nothing to read')
  if (typeof selection !== 'object' || selection === null)
    throw new InvalidOcrSelectionError('the selection is not valid')
  const s = selection as { kind?: unknown; pages?: unknown }
  if (s.kind === 'all') return Array.from({ length: count }, (_, i) => i + 1)
  if (s.kind !== 'pages' || !Array.isArray(s.pages))
    throw new InvalidOcrSelectionError('the selection is not valid')
  if (s.pages.length === 0) throw new EmptyOcrSelectionError()
  if (s.pages.length > Math.min(count, OCR_MAX_ITEMS))
    throw new InvalidOcrSelectionError('the selection names more items than there are')
  const seen = new Set<number>()
  for (const page of s.pages) {
    if (!Number.isInteger(page) || (page as number) < 1 || (page as number) > count)
      throw new InvalidOcrSelectionError(`item ${String(page)} is not between 1 and ${count}`)
    if (seen.has(page as number))
      throw new InvalidOcrSelectionError(`item ${String(page)} is selected twice`)
    seen.add(page as number)
  }
  return [...seen].sort((a, b) => a - b)
}

const aborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true

/** a call error that a second try may fix (the document jobs retry these once) */
function retryable(err: unknown): boolean {
  const kind = classifyRunError(err).kind
  return kind === 'timeout' || kind === 'network' || kind === 'overloaded'
}

/**
 * Read the selected items with the project's OCR provider and write them
 * into a new output file after destination confirmation. Embedded sources retain their format.
 */
export async function runOcr(args: RunOcrArgs): Promise<RunOcrResult> {
  const { bridge, signal } = args
  const sources = Array.isArray(args.source)
    ? (args.source as readonly SourceEntry[])
    : [args.source as SourceEntry]
  // an empty pick is refused before anything else happens
  if (args.selection.kind === 'pages' && args.selection.pages.length === 0)
    throw new EmptyOcrSelectionError()

  const ownLease = args.prepared === undefined
  const prepared =
    args.prepared ??
    (await bridge.prepare(
      args.dir,
      sources.map((s) => s.file),
    ))
  try {
    if (prepared.ocr.kind !== 'ai') throw new OcrDisabledError()
    if (prepared.kind === 'embedded' && !args.choosePlacement)
      throw new OcrFailedError('an embedded OCR destination must be chosen')
    const provider = prepared.ocr.provider
    const pages = resolveOcrSelection(args.selection, prepared.items.length)
    if (aborted(signal)) throw new OcrCancelledError()
    if (!(await args.confirm(pages.length))) throw new OcrCancelledError()
    if (aborted(signal)) throw new OcrCancelledError()
    await bridge.start(prepared.token, pages)
    return await readAndWrite(args, prepared, provider, pages)
  } finally {
    if (ownLease) await bridge.release(prepared.token).catch(() => undefined)
  }
}

async function readAndWrite(
  args: RunOcrArgs,
  prepared: OcrPrepared,
  provider: OcrProvider,
  pages: number[],
): Promise<RunOcrResult> {
  const { bridge, signal } = args
  const token = prepared.token
  const asBoxes = (index: number): boolean =>
    args.boxes === true &&
    prepared.kind === 'embedded' &&
    prepared.format === 'docx' &&
    prepared.items.find((item) => item.index === index)?.boxable === true
  const inner = new AbortController()
  const onAbort = () => inner.abort(signal?.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  const ask = (request: AiReadRequest, s: AbortSignal) => args.ask(provider, request, s)

  const results = new Map<number, unknown>()
  const failed: number[] = []
  const failures = new Map<number, OcrFailure>()
  let failuresInARow = 0
  let stopped: RunOcrResult['stopped']
  let stopCause: { kind?: string; resetsAt?: number; message: string } | undefined
  let next = 0
  let done = 0
  const report = (current: number | null) =>
    args.onProgress?.({ done, total: pages.length, current })

  const stop = (why: NonNullable<RunOcrResult['stopped']>) => {
    stopped ??= why
    inner.abort()
  }

  const readOne = async (index: number): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      try {
        const image = await bridge.pageImage(token, index)
        if (asBoxes(index)) {
          results.set(
            index,
            await readOcrBoxes({
              image: image.data,
              mime: image.mime,
              ask,
              signal: inner.signal,
            }),
          )
          failuresInARow = 0
          return
        }
        const reading = await readAiPage({
          page: index,
          pageFingerprint: '',
          image: image.data,
          mime: image.mime,
          ask,
          signal: inner.signal,
        })
        results.set(index, reading.payload)
        failuresInARow = 0
        return
      } catch (err) {
        if (inner.signal.aborted) return
        const cause = classifyRunError(err)
        if (isJobStopKind(cause.kind)) {
          stopCause = cause
          stop('connection')
          return
        }
        if (attempt === 0 && retryable(err)) continue
        failed.push(index)
        failures.set(index, {
          index,
          reason:
            (err as { reason?: unknown } | null)?.reason === 'malformed-response'
              ? 'malformed'
              : 'error',
          message: safeOcrMessage(err),
        })
        if (++failuresInARow >= OCR_MAX_FAILURES_IN_A_ROW) {
          stopCause = cause
          stop('failures')
        }
        return
      }
    }
  }

  const worker = async (): Promise<void> => {
    while (!inner.signal.aborted && next < pages.length) {
      const index = pages[next++]!
      report(index)
      await readOne(index)
      if (!inner.signal.aborted || results.has(index)) done++
      report(null)
    }
  }

  try {
    report(null)
    await Promise.all(
      Array.from({ length: Math.min(OCR_CONCURRENCY, pages.length) }, () => worker()),
    )
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
  if (aborted(signal)) stopped = 'cancelled'

  const read = pages.filter((p) => results.has(p))
  if (stopped !== 'cancelled') {
    // pages a stop left unasked are reported too, so a retry can take them
    for (const p of pages)
      if (!results.has(p) && !failures.has(p))
        failures.set(p, {
          index: p,
          reason: 'stopped',
          message: stopCause ? safeOcrMessage(stopCause.message) : '',
        })
  }
  args.onSettled?.({
    read,
    failures: [...failures.values()].sort((a, b) => a.index - b.index),
    ...(stopped ? { stopped } : {}),
  })
  if (read.length === 0) {
    if (stopped === 'cancelled') throw new OcrCancelledError()
    throw new OcrFailedError(
      `no item could be read${stopCause ? `: ${stopCause.message}` : ''}`,
      stopCause,
    )
  }
  const pagesToWrite = read.map((index) => ({ index, payload: results.get(index) }))
  let written: OcrWritten
  if (args.prepared?.kind === 'embedded' || args.choosePlacement) {
    if (!args.choosePlacement) throw new OcrFailedError('an OCR destination must be chosen')
    let error: unknown
    for (;;) {
      const placement = await args.choosePlacement(pagesToWrite, error)
      if (!placement || aborted(signal)) throw new OcrCancelledError()
      try {
        written = await bridge.write(token, pagesToWrite, placement)
        break
      } catch (err) {
        if (!(err instanceof Error) || !err.message.includes('[INVALID_ARGUMENT]')) throw err
        error = err
      }
    }
  } else written = await bridge.write(token, pagesToWrite)
  return {
    outputPath: written.outputPath,
    read,
    failed: failed.sort((a, b) => a - b),
    ...(stopped ? { stopped } : {}),
  }
}
