import type { OcrMode, SourceEntry } from '@genoffice/translate-project'
import type { AiReadRequest } from '../../../../packages/pdf-structure/src/ai-read/instruction'
import { readAiPage } from '../../../../packages/pdf-structure/src/ai-read/read-page'
import { classifyRunError, isJobStopKind } from '../../../../packages/pdf-structure/src/jobs/errors'

/**
 * OCR of a translation project's scanned PDF or image sources through the
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

/** one readable item: a PDF page or an image file */
export interface OcrItem {
  /** 1-based position */
  index: number
  /** PDF: '' (the screen says "page N"); images: the plain file name */
  name: string
}

/** what `prepare` answers: the items to choose from, under a token main holds */
export interface OcrPrepared {
  token: string
  kind: 'pdf' | 'images'
  ocr: OcrMode
  items: OcrItem[]
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
  /** the Word document in the project's output/ folder */
  docxPath: string
}

/** the bridge calls `runOcr` needs (window.translateApi in the app) */
export interface OcrBridge {
  prepare(dir: string, files: string[]): Promise<OcrPrepared>
  /** the person confirmed these items; main serves and accepts only them from now on */
  start(token: string, pages: number[]): Promise<void>
  pageImage(token: string, index: number): Promise<OcrPageImage>
  write(token: string, pages: OcrPageResult[]): Promise<OcrWritten>
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
  /** a PDF (alone) or one or more image sources, in the order they are listed */
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
 * into one Word document in output/. See the module comment for the rules.
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
    const provider = prepared.ocr.provider
    const pages = resolveOcrSelection(args.selection, prepared.items.length)
    if (aborted(signal)) throw new OcrCancelledError()
    if (!(await args.confirm(pages.length))) throw new OcrCancelledError()
    if (aborted(signal)) throw new OcrCancelledError()
    await bridge.start(prepared.token, pages)
    return await readAndWrite(args, prepared.token, provider, pages)
  } finally {
    if (ownLease) await bridge.release(prepared.token).catch(() => undefined)
  }
}

async function readAndWrite(
  args: RunOcrArgs,
  token: string,
  provider: OcrProvider,
  pages: number[],
): Promise<RunOcrResult> {
  const { bridge, signal } = args
  const inner = new AbortController()
  const onAbort = () => inner.abort(signal?.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  const ask = (request: AiReadRequest, s: AbortSignal) => args.ask(provider, request, s)

  const results = new Map<number, unknown>()
  const failed: number[] = []
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
  if (read.length === 0) {
    if (stopped === 'cancelled') throw new OcrCancelledError()
    throw new OcrFailedError(
      `no item could be read${stopCause ? `: ${stopCause.message}` : ''}`,
      stopCause,
    )
  }
  const written = await bridge.write(
    token,
    read.map((index) => ({ index, payload: results.get(index) })),
  )
  return {
    docxPath: written.docxPath,
    read,
    failed: failed.sort((a, b) => a - b),
    ...(stopped ? { stopped } : {}),
  }
}
