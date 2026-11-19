import type { ChatOcrPlaceInDocument } from '@genoffice/project-store/folder-api'
import type { Editor } from '@tiptap/core'
import type { ParsedDocFull } from '@genoffice/docx-engine'
import { placeOcrIntoOpenDocx } from '../../../shell/src/main/translate/ocr-docx-placement'
import { isHistoryTransaction } from '@tiptap/pm/history'
import type { Transaction } from '@tiptap/pm/state'
import {
  clearOcrHistory,
  getOcrHistory,
  setOcrHistory,
  type OcrSnapshot,
} from './ocr-history-state'
import {
  buildDocBytes,
  currentDocGeneration,
  swapDocumentContent,
  type FileActionContext,
} from './file-actions'
import { isPhasedContentPending, waitForFullContent } from './phased-content'
import { parseDocxOffThread } from './parse-off-thread'
import { aiEditUndoHistoryEnabled } from '@genoffice/ui'

/**
 * OCR text into the Word document on screen. The chat's `document_ocr` hands over the pictures read
 * and the placement; this puts them into the document the person is looking at instead of a new
 * file: the bytes the editor would save now (unsaved edits included) get the boxes, the result
 * replaces what is on screen, and the document is unsaved until the person saves it.
 *
 * Undo: the swap changes the save baseline along with the content, so the editor's own history
 * cannot step back over it. The state before the swap is kept instead, and undo (when the editor
 * has nothing left to undo) and redo bring it back and forward. A save, or opening another
 * document, ends it. With AI edit undo history off (decision 0114), a temporary before-state
 * still restores a failed swap, but no before/after document copies remain as undo history.
 */

export { clearOcrHistory }

/**
 * Why the document on screen cannot take OCR text now, in plain words for the person and the
 * model, or null when it can. It must be a Word document that is editable, not encrypted, and with
 * no other unsaved change than its body: the bytes made from the screen would bake those in, and
 * undo could not give them back.
 */
export interface OcrOpenDocumentOptions {
  /**
   * The editor is read-only only because the translation view locks its output while the AI runs.
   * That lock holds off the person, not the AI's own write, and the chat tool's apply always runs
   * during an AI run, so it is not a reason. Read Mode and a protected document are not this.
   */
  translationLocked?: boolean
  currentContext?: () => FileActionContext
}

export function ocrIntoDocumentUnavailableReason(
  ctx: FileActionContext,
  options: OcrOpenDocumentOptions = {},
): string | null {
  const { doc, editor } = ctx
  if (!doc || !editor || editor.isDestroyed) return 'there is no document on screen'
  if (!editor.isEditable && !options.translationLocked)
    return 'it is read-only (a source copy, Read Mode or a protected document)'
  if (doc.format !== 'docx' || doc.odt) return 'it is not a docx document (an ODT document)'
  if (doc.encrypted) return 'it is password-protected'
  return pendingOcrEditReason(ctx)
}

/** A swap also restores page layout, headers, comments and other file-level state. */
export function pendingOcrEditReason(ctx: FileActionContext): string | null {
  const pending: [string, boolean][] = [
    ['page setup or sections', !!ctx.sectionDirty || ctx.sectionsDirty?.length > 0],
    ['page numbers', ctx.pgNumDirtySections?.length > 0 || ctx.pgNumEdit != null],
    ['page color', !!ctx.pageColorDirty],
    ['header', !!ctx.headerDirty],
    ['footer', !!ctx.footerDirty],
    [
      'header or footer variants',
      ctx.hfVariantsDirty?.length > 0 || Object.keys(ctx.sectionHfEdits ?? {}).length > 0,
    ],
    ['title page', !!ctx.titlePgDirty],
    ['odd and even headers', !!ctx.evenOddHfDirty],
    ['mirror margins', !!ctx.mirrorMarginsDirty],
    ['comments', !!ctx.commentsDirty],
    ['watermark', !!ctx.watermarkDirty],
    ['ink drawings', !!ctx.inksDirty || ctx.inkAnnotations?.length > 0],
    ['footnotes or endnotes', !!ctx.notesDirty],
    ['sources', !!ctx.sourcesDirty],
    ['reference manager data', !!ctx.zoteroDocumentDataDirty],
    ['theme fonts', !!ctx.themeFontsDirty],
    ['theme colors', !!ctx.themeColorsDirty],
    ['protection', !!ctx.protectionDirty || !!ctx.writeProtectionDirty],
    ['personal information', !!ctx.removePersonalInfoDirty],
    ['numbering', !!ctx.numberingDirty],
    ['styles', Object.keys(ctx.styleUpserts ?? {}).length > 0],
  ]
  const names = pending.filter(([, set]) => set).map(([name]) => name)
  return names.length > 0
    ? `it has unsaved changes outside the body text (${names.join(', ')}): save it first`
    : null
}

/** whether the document on screen can take OCR text now */
export const ocrIntoDocumentAvailable = (ctx: FileActionContext): boolean =>
  ocrIntoDocumentUnavailableReason(ctx) === null

export interface OcrOpenDocumentDeps {
  /** the bytes the editor would save now */
  buildBytes: (ctx: FileActionContext) => Promise<Uint8Array | null>
  parse: (bytes: Uint8Array) => Promise<ParsedDocFull>
}
const REAL: OcrOpenDocumentDeps = { buildBytes: buildDocBytes, parse: parseDocxOffThread }

const reasonOf = (err: unknown): string =>
  err instanceof Error
    ? err.message.replace(/^\[[A-Z_]+\]\s*/, '')
    : 'the editor could not place it'

export async function placeOcrIntoOpenDocument(
  ctx: FileActionContext,
  plan: ChatOcrPlaceInDocument,
  deps: OcrOpenDocumentDeps = REAL,
  options: OcrOpenDocumentOptions = {},
): Promise<{ ok: true; placed: number[]; skipped: number[] } | { ok: false; reason: string }> {
  const unavailable = ocrIntoDocumentUnavailableReason(ctx, options)
  if (unavailable) return { ok: false, reason: unavailable }
  const generation = currentDocGeneration()
  const stillHere = () =>
    generation === currentDocGeneration() && !!ctx.editor && !ctx.editor.isDestroyed
  let placed: Awaited<ReturnType<typeof placeOcrIntoOpenDocx>>
  let reparsed: ParsedDocFull
  let body: Editor['state']['doc'] | undefined
  try {
    if (isPhasedContentPending()) {
      if (!(await waitForFullContent()))
        return { ok: false, reason: 'the document did not finish loading' }
      if (!stillHere() || isPhasedContentPending())
        return { ok: false, reason: 'the document changed while the text was placed' }
    }
    body = ctx.editor?.state.doc
    const bytes = await deps.buildBytes(ctx)
    if (!bytes) return { ok: false, reason: 'the document could not be read from the screen' }
    placed = await placeOcrIntoOpenDocx(bytes, plan.items, plan.placement)
    reparsed = await deps.parse(placed.bytes)
  } catch (err) {
    return { ok: false, reason: reasonOf(err) }
  }
  // a document opened or closed while this ran must not receive another document's text
  const current = options.currentContext?.() ?? ctx
  if (
    !stillHere() ||
    !ctx.doc ||
    !current.doc ||
    !ctx.editor ||
    current.editor !== ctx.editor ||
    current.doc.parsed !== ctx.doc.parsed ||
    current.editor.state.doc !== body ||
    ocrIntoDocumentUnavailableReason(current, options)
  )
    return { ok: false, reason: 'the document changed while the text was placed' }
  ctx = current
  const editor = current.editor
  const keepHistory = aiEditUndoHistoryEnabled()
  const before: OcrSnapshot = {
    state: editor.state,
    doc: current.doc,
    dirty: ctx.dirtyRef.current,
  }
  const previousHistory = getOcrHistory()
  // the translation lock is let go for the moment of the swap and put back as it was
  const relock = !editor.isEditable
  if (relock) editor.setEditable(true, false)
  try {
    swapDocumentContent(ctx, reparsed)
    ctx.dirtyRef.current = true
    setOcrHistory(
      keepHistory
        ? {
            before,
            after: { state: editor.state, doc: { ...before.doc, parsed: reparsed }, dirty: true },
            applied: true,
          }
        : null,
    )
  } catch (err) {
    try {
      restore(ctx, before)
      setOcrHistory(previousHistory)
    } catch {
      clearOcrHistory()
    }
    return { ok: false, reason: reasonOf(err) }
  } finally {
    if (relock && !editor.isDestroyed) editor.setEditable(false, false)
  }
  return { ok: true, placed: placed.placed, skipped: placed.skipped }
}

function restore(ctx: FileActionContext, snapshot: OcrSnapshot): void {
  swapDocumentContent(ctx, snapshot.doc.parsed, snapshot.state)
  ctx.dirtyRef.current = snapshot.dirty
}

/** undo reaches the OCR text only when the editor has nothing of its own left to undo */
export function ocrUndoAvailable(editor: Editor): boolean {
  const history = getOcrHistory()
  return !!history?.applied && !editor.can().undo() && editor.state.doc.eq(history.after.state.doc)
}
export function ocrRedoAvailable(editor: Editor): boolean {
  const history = getOcrHistory()
  return !!history && !history.applied && editor.state.doc.eq(history.before.state.doc)
}

/** Typing after an OCR undo starts a new branch, even if that typing is later undone. */
export function discardBranchedOcrRedo({ transaction }: { transaction: Transaction }): void {
  const history = getOcrHistory()
  if (history && !history.applied && transaction.docChanged && !isHistoryTransaction(transaction)) {
    clearOcrHistory()
  }
}

export function tryOcrUndo(ctx: FileActionContext): boolean {
  const editor = ctx.editor
  const history = getOcrHistory()
  if (!editor || !history || !ocrUndoAvailable(editor) || pendingOcrEditReason(ctx)) return false
  // Include redo of the later typing the person undid on their way back to the OCR.
  const after = { ...history.after, state: editor.state }
  restore(ctx, history.before)
  setOcrHistory({ ...history, after, applied: false })
  return true
}

export function tryOcrRedo(ctx: FileActionContext): boolean {
  const editor = ctx.editor
  const history = getOcrHistory()
  if (!editor || !history || !ocrRedoAvailable(editor) || pendingOcrEditReason(ctx)) return false
  restore(ctx, history.after)
  setOcrHistory({ ...history, applied: true })
  return true
}
