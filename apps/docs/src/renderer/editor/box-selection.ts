/**
 * Text selected with the mouse inside a text box.
 *
 * The boxes of a document (and the ones OCR puts over a picture) are islands: the editor draws
 * and edits their text itself, so ProseMirror has no range there and its selection says nothing
 * about the words under the mouse. The entry that offers "ask AI" on a selection reads the
 * browser's own selection instead, and only when it lies inside one box of this editor.
 */

import type { Editor } from '@tiptap/core'

export interface BoxSelectionRect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface BoxSelection {
  /** the selected words: whitespace collapsed */
  text: string
  /** where the selection ends, in the viewport */
  rect: BoxSelectionRect
  /** a copy of the selection's range: it outlives the browser's selection (an input takes that) */
  range: Range
}

const BOX = '.doc-textbox'

function elementOf(node: Node | null): Element | null {
  if (!node) return null
  return node.nodeType === 1 ? (node as Element) : node.parentElement
}

/** the viewport rectangle at the end of a range, null where there is no layout */
export function rangeEndRect(range: Range): BoxSelectionRect | null {
  const rects = range.getClientRects?.()
  const last = rects && rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect?.()
  if (!last) return null
  return { left: last.left, top: last.top, right: last.right, bottom: last.bottom }
}

/** the words selected inside one text box of `root`, or null: a caret, white space, anything
 *  outside a box, a selection over several boxes, a box of another editor */
export function readBoxSelection(
  root: HTMLElement,
  selection: Selection | null,
): BoxSelection | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  const box = elementOf(range.commonAncestorContainer)?.closest(BOX)
  if (!box || !root.contains(box)) return null
  const text = selection.toString().replace(/\s+/g, ' ').trim()
  if (!text) return null
  const rect = rangeEndRect(range)
  if (!rect) return null
  return { text, rect, range: range.cloneRange() }
}

/**
 * The request that goes to the AI for words picked in a box. The editor has no range there, so
 * the words travel in the request itself (a run scoped to a range cannot name them).
 */
export function withBoxQuote(instruction: string, quote: string): string {
  return `${instruction.trim()}\n\n"${quote}"`
}

/**
 * A run is scoped to the editor's own selection. The editor ignores what happens inside a box,
 * so a range chosen earlier in the body is still there; it is not what the person just picked,
 * and an edit scoped to it would change the wrong words. It is collapsed before the request.
 */
export function dropEditorRange(editor: Pick<Editor, 'state' | 'commands'>): void {
  const { empty, to } = editor.state.selection
  if (!empty) editor.commands.setTextSelection(to)
}
