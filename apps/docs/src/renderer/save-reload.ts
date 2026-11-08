import type { Editor } from '@tiptap/core'
import { Mark, type Node as PmNodeType } from '@tiptap/pm/model'
import { TRACK_IGNORE } from './editor/revisions'

/**
 * Attributes that only point into the saved file (patch anchors) or mark AI highlighting.
 * A re-parse of freshly saved bytes legitimately changes them without the document changing.
 */
const ANCHOR_ATTRS = ['docxIndex'] as const
const IGNORED_ATTRS = new Set<string>([...ANCHOR_ATTRS, 'aiChanged'])

type AnchorUpdate = { pos: number; value: unknown }

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a as object)
  const kb = Object.keys(b as object)
  if (ka.length !== kb.length) return false
  return ka.every((k) => deepEqual((a as never)[k], (b as never)[k]))
}

/**
 * Walks both trees in lockstep. Returns false when they differ in anything but the ignored
 * attributes; otherwise appends one update per node whose docxIndex differs.
 */
function collectAnchorDiffs(
  live: PmNodeType,
  next: PmNodeType,
  pos: number,
  out: AnchorUpdate[],
): boolean {
  if (live.type !== next.type) return false
  if (live.isText) return live.text === next.text && Mark.sameSet(live.marks, next.marks)
  if (!Mark.sameSet(live.marks, next.marks)) return false
  const keys = new Set([...Object.keys(live.attrs), ...Object.keys(next.attrs)])
  for (const k of keys) {
    if (IGNORED_ATTRS.has(k)) continue
    if (!deepEqual(live.attrs[k], next.attrs[k])) return false
  }
  if (live.attrs.docxIndex !== next.attrs.docxIndex && pos >= 0) {
    out.push({ pos, value: next.attrs.docxIndex ?? null })
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

/**
 * Applies a reloaded (re-parsed) document that equals the live one apart from file anchors.
 * Only the differing docxIndex values are written, by attribute-only steps outside the undo
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
  for (const u of updates) tr.setNodeAttribute(u.pos, 'docxIndex', u.value)
  tr.setMeta('addToHistory', false)
  tr.setMeta(TRACK_IGNORE, true)
  editor.view.dispatch(tr)
  return 'anchors'
}
