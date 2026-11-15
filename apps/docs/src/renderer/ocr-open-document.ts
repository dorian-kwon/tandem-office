import type { ChatOcrPlaceInDocument } from '@genoffice/project-store/folder-api'
import type { Editor } from '@tiptap/core'
import type { ParsedDocFull } from '@genoffice/docx-engine'
import { placeOcrIntoOpenDocx } from '../../../shell/src/main/translate/ocr-docx-placement'
import type { PmNode } from './editor/convert'
import {
  clearOcrHistory,
  getOcrHistory,
  setOcrHistory,
  type OcrHistory,
  type OcrSnapshot,
} from './ocr-history-state'
import {
  buildDocBytes,
  currentDocGeneration,
  swapDocumentContent,
  type FileActionContext,
} from './file-actions'
import { parseDocxOffThread } from './parse-off-thread'

/**
 * OCR text into the Word document on screen. The chat's `document_ocr` hands over the pictures read
 * and the placement; this puts them into the document the person is looking at instead of a new
 * file: the bytes the editor would save now (unsaved edits included) get the boxes, the result
 * replaces what is on screen, and the document is unsaved until the person saves it.
 *
 * Undo: the swap changes the save baseline along with the content, so the editor's own history
 * cannot step back over it. The state before the swap is kept instead, and undo (when the editor
 * has nothing left to undo) and redo bring it back and forward. A save, or opening another
 * document, ends it.
 */

export { clearOcrHistory }

/**
 * Why the document on screen cannot take OCR text now, in plain words for the person and the
 * model, or null when it can. It must be a Word document that is editable, not encrypted, and with
 * no other unsaved change than its body: the bytes made from the screen would bake those in, and
 * undo could not give them back.
 */
export function ocrIntoDocumentUnavailableReason(ctx: FileActionContext): string | null {
  const { doc, editor } = ctx
  if (!doc || !editor || editor.isDestroyed) return 'there is no document on screen'
  if (!editor.isEditable)
    return 'it is read-only (a source copy, Read Mode or a translation that is still running)'
  if (doc.format !== 'docx' || doc.odt) return 'it is not a docx document (an ODT document)'
  if (doc.encrypted) return 'it is password-protected'
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
): Promise<{ ok: true; placed: number[]; skipped: number[] } | { ok: false; reason: string }> {
  const unavailable = ocrIntoDocumentUnavailableReason(ctx)
  if (unavailable) return { ok: false, reason: unavailable }
  const generation = currentDocGeneration()
  const stillHere = () =>
    generation === currentDocGeneration() && !!ctx.editor && !ctx.editor.isDestroyed
  let placed: Awaited<ReturnType<typeof placeOcrIntoOpenDocx>>
  let reparsed: ParsedDocFull
  try {
    const bytes = await deps.buildBytes(ctx)
    if (!bytes) return { ok: false, reason: 'the document could not be read from the screen' }
    placed = await placeOcrIntoOpenDocx(bytes, plan.items, plan.placement)
    reparsed = await deps.parse(placed.bytes)
  } catch (err) {
    return { ok: false, reason: reasonOf(err) }
  }
  // a document opened or closed while this ran must not receive another document's text
  if (!stillHere() || !ctx.doc || !ctx.editor)
    return { ok: false, reason: 'the document changed while the text was placed' }
  const editor = ctx.editor
  const before: OcrSnapshot = {
    pm: editor.getJSON() as PmNode,
    doc: ctx.doc,
    dirty: ctx.dirtyRef.current,
  }
  // set before the swap: the buttons that follow the editor's transactions see undo is possible
  const history: OcrHistory = { before, after: null, applied: true, restored: null }
  setOcrHistory(history)
  try {
    swapDocumentContent(ctx, reparsed)
    ctx.dirtyRef.current = true
    history.after = {
      pm: editor.getJSON() as PmNode,
      doc: { ...before.doc, parsed: reparsed },
      dirty: true,
    }
  } catch (err) {
    setOcrHistory(null)
    // put back what was on screen
    try {
      restore(ctx, before)
    } catch {
      /* the swap failed before it changed anything that matters */
    }
    return { ok: false, reason: reasonOf(err) }
  }
  return { ok: true, placed: placed.placed, skipped: placed.skipped }
}

function restore(ctx: FileActionContext, snapshot: OcrSnapshot): void {
  swapDocumentContent(ctx, snapshot.doc.parsed, snapshot.pm)
  ctx.dirtyRef.current = snapshot.dirty
}

/** undo reaches the OCR text only when the editor has nothing of its own left to undo */
export function ocrUndoAvailable(editor: Editor): boolean {
  const history = getOcrHistory()
  return !!history?.applied && !!history.after && !editor.can().undo()
}
export function ocrRedoAvailable(editor: Editor): boolean {
  const history = getOcrHistory()
  return !!history && !history.applied && editor.state.doc === history.restored
}

export function tryOcrUndo(ctx: FileActionContext): boolean {
  const editor = ctx.editor
  const history = getOcrHistory()
  if (!editor || !history || !ocrUndoAvailable(editor)) return false
  history.applied = false
  restore(ctx, history.before)
  history.restored = editor.state.doc
  return true
}

export function tryOcrRedo(ctx: FileActionContext): boolean {
  const editor = ctx.editor
  const history = getOcrHistory()
  if (!editor || !history?.after || !ocrRedoAvailable(editor)) return false
  history.applied = true
  restore(ctx, history.after)
  return true
}
