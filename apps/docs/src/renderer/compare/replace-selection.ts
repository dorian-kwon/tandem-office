/**
 * Replace the text the popup was opened on with one candidate. The same
 * formatting-preserving replacement the AI's replace_selection tool uses
 * (`replaceInlineRange`): the new text carries the marks of the first replaced
 * character (run style, font, size), it is ONE transaction (one undo step) and
 * it is recorded as a tracked change when the track toggle is on.
 *
 * The popup stores the range and a fingerprint of the text when it opens. If
 * the document changed since (the text under the range is no longer the same)
 * nothing is replaced.
 */
import type { Editor } from '@tiptap/core'
import type { Mark } from '@tiptap/pm/model'
import { replaceInlineRange, type AiTrack } from '../ai/protocol'

export interface SelectionSnapshot {
  from: number
  to: number
  /** the selected text, whitespace collapsed */
  fingerprint: string
}

const REVISION_MARKS = new Set(['ins', 'del'])

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** the text of a range as the popup shows and compares it */
export function rangeText(editor: Editor, from: number, to: number): string {
  return collapse(editor.state.doc.textBetween(from, to, ' ', ' '))
}

/** the current selection as a snapshot, or null when nothing is selected */
export function snapshotSelection(editor: Editor): SelectionSnapshot | null {
  const { from, to, empty } = editor.state.selection
  if (empty) return null
  const fingerprint = rangeText(editor, from, to)
  return fingerprint ? { from, to, fingerprint } : null
}

export type ReplaceResult = { ok: true } | { ok: false; reason: 'stale' | 'unsupported' | 'empty' }

export function replaceSnapshot(
  editor: Editor,
  snap: SelectionSnapshot,
  text: string,
  track?: AiTrack,
): ReplaceResult {
  const next = text.replace(/\s*\n\s*/g, ' ').trim()
  if (!next) return { ok: false, reason: 'empty' }
  const doc = editor.state.doc
  if (!editor.isEditable) return { ok: false, reason: 'unsupported' }
  if (snap.from < 0 || snap.to > doc.content.size || snap.from >= snap.to)
    return { ok: false, reason: 'stale' }
  if (rangeText(editor, snap.from, snap.to) !== snap.fingerprint)
    return { ok: false, reason: 'stale' }
  const $from = doc.resolve(snap.from)
  const $to = doc.resolve(snap.to)
  // text inside ONE paragraph, heading or list item: at the top level or inside a table cell or
  // another container (a selection across several paragraphs is not replaced)
  if ($from.depth < 1 || !$from.sameParent($to) || !$from.parent.isTextblock)
    return { ok: false, reason: 'unsupported' }
  const anchor = $from.parent.childAfter($from.parentOffset).node
  const inherited: readonly Mark[] = (anchor?.marks ?? []).filter(
    (mark) => !REVISION_MARKS.has(mark.type.name),
  )
  replaceInlineRange(editor, snap.from, snap.to, [editor.schema.text(next, inherited)], track)
  return { ok: true }
}
