import type { TableModel } from '@genoffice/docx-engine'
import type { PmNode } from './editor/convert'

/**
 * Word-style progressive open for large documents.
 *
 * Mounting a 60-page document in one setContent keeps the "Opening…" screen up
 * until the whole ProseMirror DOM is built and laid out — the dominant share of
 * cold-open time. Instead, mount enough blocks to overfill the first screens,
 * let the browser paint them, then append the tail in frame-sized chunks while
 * the user already reads page 1 (the page count in the status bar grows as the
 * tail streams in, like Word's background pagination).
 *
 * While the tail streams the document is incomplete, so:
 * - the editor stays editable except at the append boundary (the streaming
 *   tail guard refuses edits in or after the last mounted block),
 * - saves must wait on waitForFullContent() — a mid-stream save would
 *   serialize, and write to disk, a truncated document,
 * - appends bypass undo history and restore the dirty flag, so streaming is
 *   not an edit; history resets once the tail lands unless the user edited
 *   meanwhile (their undo stack must survive).
 */
export interface PhasedContentHost {
  /** full replace (Tiptap setContent) */
  setContent(doc: PmNode): void
  /** append top-level nodes at the document end, outside undo history */
  appendNodes(nodes: PmNode[], recover?: boolean): void
  blockCount(): number
  onError?(error: unknown): void
  isDestroyed(): boolean
  resetHistory(): void
  /** read-only + save-gate flag while the tail streams */
  setLoading(loading: boolean): void
  getDirty(): boolean
  setDirty(dirty: boolean): void
}

/** dispatched on document once a streamed tail has fully landed (layout
 *  measurers skip the tail's chunks and measure the whole document once) */
export const PHASED_CONTENT_SETTLED_EVENT = 'genoffice:phased-content-settled'

/** blocks in the first synchronous mount: overfills the first screens at any zoom */
export const PHASE1_BLOCKS = 64
/** blocks appended per scheduled chunk while the tail streams in */
export const PHASE_CHUNK_BLOCKS = 128
/** Ordinary paragraphs count as one unit. A table also pays for its descendants. */
export const PHASED_MIN_BLOCKS = 192

// Four model nodes per unit lets simple tables share a frame. Stop counting once
// a single table exceeds every budget: a table must always be mounted whole.
function nestedTableSize(table: TableModel, limit: number): number {
  let count = 1
  for (const row of table.rows) {
    if (++count >= limit) return limit
    for (const cell of row) {
      count += 1 + Math.max(1, cell.richParas?.length ?? cell.paras.length)
      if (count >= limit) return limit
      for (const nested of cell.nestedTables ?? []) {
        count += nestedTableSize(nested, limit - count)
        if (count >= limit) return limit
      }
    }
  }
  return count
}

function nodeCount(node: PmNode, limit: number): number {
  // A nested table is a leaf in ProseMirror; its NodeView renders the stored model.
  if (node.type === 'docNestedTable' && node.attrs?.model) {
    return nestedTableSize(node.attrs.model as TableModel, limit)
  }
  let count = 1
  for (const child of node.content ?? []) {
    if (count >= limit) break
    count += nodeCount(child, limit - count)
  }
  return count
}

function chunkEnd(content: PmNode[], start: number, budget: number): number {
  let end = start
  let remaining = budget
  while (end < content.length && remaining > 0) {
    const block = content[end]!
    const weight =
      block.type === 'docTable' ? Math.ceil(nodeCount(block, remaining * 4 + 1) / 4) : 1
    if (end > start && weight > remaining) break
    remaining -= weight
    end++
  }
  return end
}

/** bumping the token cancels the pending tail (its chunks become no-ops) */
let token = 0
let settled = Promise.resolve(true)
let failed = false
let finalPageScroll: HTMLElement | null = null
let phasedDocument = false
let readingInput: { until: number; wheel?: { scroller: HTMLElement; down: boolean } } | null = null
let fullContentRequested = false
// Leave room for the browser to deliver the next input event after a heavy table paints.
const INPUT_IDLE_MS = 240
/** clears the loading flag / resolves settled when a load is cancelled mid-stream */
let cancelPending: (() => void) | null = null

/** False if this load was replaced, destroyed, or could not mount the complete document. */
export function waitForFullContent(): Promise<boolean> {
  fullContentRequested = isPhasedContentPending()
  readingInput = null
  return settled
}

export function hasPhasedContentFailed(): boolean {
  return failed
}

/** A pending or failed stream does not have a complete document to act on. */
export function isPhasedContentPending(): boolean {
  return cancelPending !== null
}

/** A live wheel gesture over already-mounted content takes priority over read-ahead. */
export function notePhasedWheel(scroller: HTMLElement, deltaY: number): void {
  if (deltaY && isPhasedContentPending() && !fullContentRequested)
    readingInput = {
      until: performance.now() + INPUT_IDLE_MS,
      wheel: { scroller, down: deltaY > 0 },
    }
}

/** Opening the dock can refit the paper and queue several full pagination
 * passes even after all blocks are mounted. A draft needs neither the tail
 * nor those passes; sending or printing releases the pending work. */
export function notePhasedChatInput(): void {
  if (phasedDocument && !fullContentRequested)
    readingInput = { until: performance.now() + INPUT_IDLE_MS }
}

export function phasedReadAheadDelay(): number {
  if (!readingInput || fullContentRequested) return 0
  const remaining = Math.ceil(readingInput.until - performance.now())
  if (remaining <= 0) {
    readingInput = null
    return 0
  }
  if (!readingInput.wheel) return remaining
  const { scroller, down } = readingInput.wheel
  // Keep feeding a reader approaching the last mounted screen.
  if (down && scroller.scrollHeight - scroller.scrollTop < 2 * scroller.clientHeight) return 0
  if (!down && scroller.scrollTop <= 1) return 0
  return remaining
}

/** Preserve a trip to the current end across a tail append or its final pagination.
 * Check the live position before each synchronous layout change so scrolling away
 * takes effect immediately. At the initial top, no size measurement is necessary. */
export function phasedScrollEnd(scroller: HTMLElement | null): HTMLElement | null {
  const streaming = isPhasedContentPending()
  if (!scroller || (!streaming && finalPageScroll !== scroller)) return null
  const atEnd =
    scroller.scrollTop > 1 &&
    scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 1
  finalPageScroll = streaming && atEnd ? scroller : null
  return atEnd ? scroller : null
}

/** Any full content replacement outside the phased path must drop a pending tail. */
export function cancelPhasedContent(): void {
  finalPageScroll = null
  readingInput = null
  phasedDocument = false
  fullContentRequested = false
  token++
  cancelPending?.()
  cancelPending = null
  failed = false
  settled = Promise.resolve(true)
}

/**
 * Double-rAF: the browser paints the previous mount between the two callbacks.
 * A timer races the frames: a background tab (a hidden shell view keeps
 * document.hidden false but is handed about one frame a second) would
 * otherwise stretch a long open into hours, one chunk per second.
 */
export const PAINTED_FRAME_FALLBACK_MS = 80
const nextPaintedFrame = (cb: () => void): void => {
  let done = false
  let raf2 = 0
  const fire = (): void => {
    if (done) return
    done = true
    clearTimeout(timer)
    cancelAnimationFrame(raf1)
    cancelAnimationFrame(raf2)
    cb()
  }
  const raf1 = requestAnimationFrame(() => {
    raf2 = requestAnimationFrame(fire)
  })
  const timer = setTimeout(fire, PAINTED_FRAME_FALLBACK_MS)
}

export function setContentPhased(
  host: PhasedContentHost,
  pmDoc: PmNode,
  schedule: (cb: () => void) => void = nextPaintedFrame,
): void {
  cancelPhasedContent()
  const content = pmDoc.content ?? []
  const my = ++token
  const onePass =
    content.length <= PHASED_MIN_BLOCKS &&
    chunkEnd(content, 0, PHASED_MIN_BLOCKS) === content.length
  let index = onePass ? content.length : chunkEnd(content, 0, PHASE1_BLOCKS)
  let settle!: (complete: boolean) => void
  settled = new Promise<boolean>((resolve) => (settle = resolve))
  // A failed load stays incomplete until a replacement explicitly clears it.
  const fail = () => {
    failed = true
    cancelPending = () => host.setLoading(false)
    settle(false)
  }
  try {
    host.setContent(onePass ? pmDoc : { ...pmDoc, content: content.slice(0, index) })
    if (index > 0 && host.blockCount() !== index)
      throw new Error('The editor did not mount the complete document.')
  } catch (error) {
    fail()
    throw error
  }
  if (onePass) {
    settle(true)
    return
  }
  phasedDocument = true
  host.setLoading(true)
  cancelPending = () => {
    host.setLoading(false)
    settle(false)
  }
  const finish = () => {
    if (!host.getDirty()) host.resetHistory()
    cancelPending = null
    fullContentRequested = false
    if (readingInput?.wheel) readingInput = null
    host.setLoading(false)
    settle(true)
    if (typeof document !== 'undefined')
      document.dispatchEvent(new Event(PHASED_CONTENT_SETTLED_EVENT))
  }
  const appendChunk = () => {
    if (my !== token) return
    if (host.isDestroyed()) {
      settle(false)
      return
    }
    const delay = phasedReadAheadDelay()
    if (delay) {
      setTimeout(appendChunk, delay)
      return
    }
    const start = index
    const count = host.blockCount()
    const wasDirty = host.getDirty()
    const append = (end: number, recover = false) => {
      let error: unknown
      try {
        host.appendNodes(content.slice(start, end), recover)
      } catch (cause) {
        error = cause
      } finally {
        host.setDirty(wasDirty)
      }
      // A view/update listener can throw after dispatch committed the entire step.
      // A transaction filter can also silently refuse it. Count from the live
      // prefix, which the user may have grown or shortened between chunks.
      if (host.blockCount() !== count + end - start)
        throw error ?? new Error('The editor did not accept the complete document.')
      index = end
    }
    try {
      append(chunkEnd(content, start, PHASE_CHUNK_BLOCKS))
    } catch (error) {
      // ProseMirror steps are atomic. An unexpected partial result cannot be
      // retried safely because the source offset of the missing tail is unknown.
      try {
        if (host.blockCount() !== count) throw error
        append(content.length, true)
      } catch (cause) {
        fail()
        host.onError?.(cause)
        return
      }
    }
    if (index < content.length) schedule(appendChunk)
    else finish()
  }
  schedule(appendChunk)
}
