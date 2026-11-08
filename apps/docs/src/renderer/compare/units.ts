/**
 * The units a whole-document comparison asks about: one non-empty text paragraph at a time, in
 * reading order. A unit is a body paragraph, a heading, a list item, or one paragraph inside a
 * table cell (the same blocks the translation tools read). Empty paragraphs, blocks that hold no
 * text (pictures, protected blocks), tracked-deleted blocks and texts without a single letter
 * (page numbers, "***") are skipped.
 *
 * Positions shift while earlier units are replaced, so a unit's range is carried through every
 * transaction (`mapRange`), and applying it checks that the text under the range is still the
 * text that was asked about.
 */
import type { Editor } from '@tiptap/core'
import type { Node as PmNodeType } from '@tiptap/pm/model'
import type { Mapping } from '@tiptap/pm/transform'
import { isTrackedDeleted } from '../ai/doc-utils'
import { textblocksOf } from '../ai/translate-runs'
import { rangeText, type SelectionSnapshot } from './replace-selection'

export interface TextUnit {
  id: string
  /** the paragraph's content range in the document (kept current by `mapRange`) */
  from: number
  to: number
  /** the text asked about, whitespace collapsed; it is also the stale-text fingerprint */
  text: string
  /** top-level block index (the Korean original is found by this position) */
  block: number
  /** the paragraph holds inline objects (footnote marks, pictures): replacing its text would drop them */
  hasObjects: boolean
}

const HAS_LETTER = /\p{L}/u

export function hasLetters(text: string): boolean {
  return HAS_LETTER.test(text)
}

export function enumerateUnits(doc: PmNodeType): TextUnit[] {
  const units: TextUnit[] = []
  let pos = 0
  doc.forEach((block, _offset, index) => {
    const start = pos
    pos += block.nodeSize
    if (isTrackedDeleted(block)) return
    for (const found of textblocksOf(block, start) ?? []) {
      const from = found.pos + 1
      const to = found.pos + found.node.nodeSize - 1
      if (to <= from || isTrackedDeleted(found.node)) continue
      const text = doc.textBetween(from, to, ' ', ' ').replace(/\s+/g, ' ').trim()
      if (!text || !hasLetters(text)) continue
      let hasObjects = false
      found.node.forEach((child) => {
        if (child.isInline && !child.isText) hasObjects = true
      })
      units.push({ id: `u${units.length}`, from, to, text, block: index, hasObjects })
    }
  })
  return units
}

/** the selection as the one unit of a selection comparison */
export function selectionUnit(editor: Editor, snap: SelectionSnapshot): TextUnit {
  const { doc } = editor.state
  const text = doc.textBetween(snap.from, snap.to, '\n', '\n').trim()
  let hasObjects = false
  doc.nodesBetween(snap.from, snap.to, (node) => {
    if (node.isInline && !node.isText) hasObjects = true
  })
  const $from = doc.resolve(snap.from)
  return {
    id: 'selection',
    from: snap.from,
    to: snap.to,
    text,
    block: $from.depth >= 1 ? $from.index(0) : 0,
    hasObjects,
  }
}

export interface LiveRange {
  from: number
  to: number
  /** the range was deleted by an edit */
  gone: boolean
}

/** a range carried through a change of the document */
export function mapRange(range: LiveRange, mapping: Mapping): LiveRange {
  if (range.gone) return range
  const from = mapping.map(range.from, 1)
  const to = mapping.map(range.to, -1)
  return to <= from ? { from, to: from, gone: true } : { from, to, gone: false }
}

/** the stale-text fingerprint of a range: what the document holds there now */
export function currentText(editor: Editor, range: { from: number; to: number }): string {
  return rangeText(editor, range.from, range.to)
}
