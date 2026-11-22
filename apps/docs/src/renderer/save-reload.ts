import type { Editor } from '@tiptap/core'
import { Mark, type Node as PmNodeType } from '@tiptap/pm/model'
import { TRACK_IGNORE } from './editor/revisions'

/**
 * Attributes that only point into the saved file (patch anchors) or record a baseline read from
 * it: `docxIndex`, a table's `originalStructure` / `originalFormatting` signatures and its rows' and
 * cells' raw property XML (the baselines the next save compares the live table against). A re-parse of freshly saved bytes
 * legitimately changes them without the document changing, so they are refreshed in place.
 * `aiChanged` marks AI highlighting and keeps its live value.
 */
const ANCHOR_ATTRS = [
  'docxIndex',
  'originalStructure',
  'originalFormatting',
  // raw property XML of a table row / cell as last read from the file; the writer may normalise it
  'rawTrPr',
  'rawTcPr',
] as const
const IGNORED_ATTRS = new Set<string>([...ANCHOR_ATTRS, 'aiChanged'])

// Only the save path can issue this transaction. It refreshes file baselines in place.
export const SAVE_REBASE = 'docxSaveRebase'
const derivedTableValues = new Set(['effective', 'colWidthsTwips', 'colWidthsPct'])
type AnchorUpdate = { pos: number; attr: string; value: unknown }

function deepEqual(a: unknown, b: unknown, ignore?: ReadonlySet<string>): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a).filter((k) => !ignore?.has(k))
  const kb = Object.keys(b).filter((k) => !ignore?.has(k))
  if (ka.length !== kb.length) return false
  return ka.every((k) => Object.hasOwn(b, k) && deepEqual((a as never)[k], (b as never)[k], ignore))
}

/**
 * Walks both trees in lockstep. Returns false when they differ in anything but the ignored
 * attributes; otherwise records the saved attribute updates without changing editor positions.
 */
function collectAnchorDiffs(
  live: PmNodeType,
  next: PmNodeType,
  pos: number,
  out?: AnchorUpdate[],
): boolean {
  if (live === next) return true
  if (live.type !== next.type) return false
  if (live.isText) return live.text === next.text && Mark.sameSet(live.marks, next.marks)
  if (!Mark.sameSet(live.marks, next.marks)) return false
  const keys = new Set([...Object.keys(live.attrs), ...Object.keys(next.attrs)])
  for (const k of keys) {
    if (IGNORED_ATTRS.has(k)) continue
    if (deepEqual(live.attrs[k], next.attrs[k])) continue
    // Reopening resolves effective styles and recomputes fitted grid widths from the edited text.
    // The nested table is a single PM atom. Refresh its model only when the cells, merges,
    // text, source styles and other properties match; the atom keeps the same document position.
    if (
      live.type.name === 'docNestedTable' &&
      k === 'model' &&
      deepEqual(live.attrs[k], next.attrs[k], derivedTableValues)
    ) {
      out?.push({ pos, attr: k, value: next.attrs[k] })
      continue
    }
    if (
      (live.type.name === 'docTable' && (k === 'colWidthsPct' || k === 'widthPx')) ||
      ((live.type.name === 'docTableCell' || live.type.name === 'docTableHeader') &&
        k === 'colwidth')
    ) {
      out?.push({ pos, attr: k, value: next.attrs[k] })
      continue
    }
    return false
  }
  if (out && pos >= 0) {
    for (const attr of ANCHOR_ATTRS) {
      if (live.attrs[attr] !== next.attrs[attr]) {
        out.push({ pos, attr, value: next.attrs[attr] ?? null })
      }
    }
  }
  if (live.childCount !== next.childCount) return false
  let offset = 0
  for (let i = 0; i < live.childCount; i++) {
    const a = live.child(i)
    const b = next.child(i)
    // the doc node has no opening token, every other node does
    const childPos = pos < 0 ? offset : pos + 1 + offset
    if (!collectAnchorDiffs(a, b, childPos, out)) return false
    offset += a.nodeSize
  }
  return true
}

/** Compare a live history state to a chat checkpoint across the save's file-only refresh. */
export function sameDocAcrossSave(a: PmNodeType, b: PmNodeType): boolean {
  return collectAnchorDiffs(a, b, -1)
}

/**
 * Applies a reloaded (re-parsed) document that equals the live one apart from file anchors.
 * Only differing file anchors and derived table values are written, by attribute-only steps outside the undo
 * history and outside Track Changes, so the doc keeps its history, selection and scroll.
 *
 * Returns 'same' (nothing to do), 'anchors' (anchors refreshed) or null when the documents differ
 * in anything else and the caller must replace the content.
 */
export function applyAnchorOnlyReload(
  editor: Editor,
  rebasedPm: unknown,
): 'same' | 'anchors' | null {
  let next: PmNodeType
  try {
    next = editor.schema.nodeFromJSON(rebasedPm)
  } catch {
    return null
  }
  const live = editor.state.doc
  if (live.eq(next)) return 'same'
  const updates: AnchorUpdate[] = []
  if (!collectAnchorDiffs(live, next, -1, updates)) return null
  if (updates.length === 0) return 'same'
  const tr = editor.state.tr
  for (const u of updates) tr.setNodeAttribute(u.pos, u.attr, u.value)
  tr.setMeta(SAVE_REBASE, true)
  tr.setMeta('addToHistory', false)
  tr.setMeta(TRACK_IGNORE, true)
  editor.view.dispatch(tr)
  return 'anchors'
}
