import { finishTranslationUnit } from '../editor/translation-history'
import {
  draftNestedTable,
  NestedTableChanges,
  nestedTextUnit,
  nestedBatches,
} from './nested-table-draft'
import type { Editor } from '@tiptap/core'
import type { Mark, Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { Transaction } from '@tiptap/pm/state'
import { TRACK_IGNORE } from '../editor/revisions'
import { isTrackedDeleted } from './doc-utils'
import {
  parseItalicSegment,
  placeSpans,
  sliceSpans,
  textNodes,
  type SpanOffsets,
} from './italic-spans'
import type { AiTrack } from './protocol'
import {
  groupsOf,
  plainTwinRole,
  revisionDate,
  runFingerprint,
  segmentsError,
  tableTwinRoles,
  textblocksOf,
  topLevel,
} from './translate-runs'

/**
 * Translation review (revise_blocks): the AI corrects an already translated
 * document and every correction is a tracked change the human reviewer can
 * accept or reject one by one.
 *
 * Input convention is translate_blocks': read_runs gives each paragraph's "fp"
 * and its segments (one per run of equal formatting), the model returns the
 * revised text of every segment. Unlike translate_blocks the edit is MINIMAL:
 * each segment is diffed against its current text word by word and only the
 * changed spans become deleted/inserted text, inside the run they belong to,
 * so the run formatting stays and an unchanged segment produces nothing. The
 * edit is always tracked, under its own author label, whatever the AI panel's
 * track-changes switch says.
 */

/** the review marker appended to the AI author so a reviewer can filter the review's changes */
export const REVIEW_AUTHOR_SUFFIX = ' (review)'
const DEFAULT_AI_AUTHOR = 'AI Assistant'

/** the author label of review changes: the AI author plus the review marker */
export function reviewAuthor(track?: AiTrack): string {
  return `${track?.author ?? DEFAULT_AI_AUTHOR}${REVIEW_AUTHOR_SUFFIX}`
}

// ---------------------------------------------------------------------------
// Word-level diff
// ---------------------------------------------------------------------------

/** one changed span: `[start, end)` of the old text becomes `text` */
export interface SpanChange {
  start: number
  end: number
  text: string
}

interface Token {
  s: number
  e: number
  v: string
}

/** whitespace runs, single CJK ideographs/kana, letter-digit words, any other single character */
const TOKEN =
  /\s+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}\p{M}]+|[\s\S]/gu

function tokenize(text: string): Token[] {
  const out: Token[] = []
  for (const m of text.matchAll(TOKEN)) out.push({ s: m.index, e: m.index + m[0].length, v: m[0] })
  return out
}

/** a pair of token tables above this many cells is not worth a quadratic table */
const MAX_DIFF_CELLS = 4_000_000

interface Hunk {
  a0: number
  a1: number
  b0: number
  b1: number
}

function hunksOf(a: Token[], b: Token[]): Hunk[] {
  let lo = 0
  while (lo < a.length && lo < b.length && a[lo].v === b[lo].v) lo++
  let ha = a.length
  let hb = b.length
  while (ha > lo && hb > lo && a[ha - 1].v === b[hb - 1].v) {
    ha--
    hb--
  }
  if (ha === lo && hb === lo) return []
  const n = ha - lo
  const m = hb - lo
  if (n === 0 || m === 0 || n * m > MAX_DIFF_CELLS) return [{ a0: lo, a1: ha, b0: lo, b1: hb }]
  // longest common subsequence table over the differing middle
  const w = m + 1
  const table = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * w + j] =
        a[lo + i].v === b[lo + j].v
          ? table[(i + 1) * w + j + 1] + 1
          : Math.max(table[(i + 1) * w + j], table[i * w + j + 1])
    }
  }
  const hunks: Hunk[] = []
  let i = 0
  let j = 0
  let open: Hunk | null = null
  const close = () => {
    if (open) hunks.push(open)
    open = null
  }
  while (i < n || j < m) {
    if (i < n && j < m && a[lo + i].v === b[lo + j].v) {
      close()
      i++
      j++
      continue
    }
    if (!open) open = { a0: lo + i, a1: lo + i, b0: lo + j, b1: lo + j }
    if (j >= m || (i < n && table[(i + 1) * w + j] >= table[i * w + j + 1])) {
      i++
      open.a1 = lo + i
    } else {
      j++
      open.b1 = lo + j
    }
  }
  close()
  return hunks
}

/**
 * The changed spans between two texts, word by word. Hunks that only a single
 * space apart are one change ("big red" to "large crimson" is one replacement,
 * not two with a stray kept space).
 */
export function diffSpans(oldText: string, newText: string): SpanChange[] {
  if (oldText === newText) return []
  const a = tokenize(oldText)
  const b = tokenize(newText)
  const merged: Hunk[] = []
  for (const h of hunksOf(a, b)) {
    const last = merged[merged.length - 1]
    const between = last ? a.slice(last.a1, h.a0) : []
    if (last && between.length > 0 && between.every((t) => /^\s+$/.test(t.v))) {
      last.a1 = h.a1
      last.b1 = h.b1
    } else merged.push({ ...h })
  }
  return merged.map((h) => {
    const start = h.a0 < a.length ? a[h.a0].s : oldText.length
    const end = h.a1 > h.a0 ? a[h.a1 - 1].e : start
    const text = h.b1 > h.b0 ? newText.slice(b[h.b0].s, b[h.b1 - 1].e) : ''
    return { start, end, text }
  })
}

// ---------------------------------------------------------------------------
// Planning and applying
// ---------------------------------------------------------------------------

export interface ReviseItem {
  index: number
  nestedTable?: number
  paragraph?: number
  /** the fingerprint read_runs gave; a mismatch refuses the item */
  fp: string
  segments: string[]
}

export interface ReviseReport {
  index: number
  nestedTable?: number
  paragraph?: number
  /** the paragraph has no text; nothing to revise */
  empty?: true
  /** the paragraph still looks written in the source language: left alone, translate it first */
  untranslated?: true
  /** tracked changes (changed spans) made in this paragraph */
  changes: number
  /** the paragraph's fingerprint after the edit */
  fp?: string
}

interface ReviseEdit {
  from: number
  to: number
  text: string
  marks: readonly Mark[]
  /** italic spans (offsets in `text`) added on top of `marks` */
  italics?: SpanOffsets
}

type Plan =
  | { ok: true; edits: ReviseEdit[]; report: ReviseReport }
  | { ok: false; error: string; stale?: true }

interface ReviewBlock {
  node: ProseMirrorNode
  paragraphs: ReturnType<typeof textblocksOf>
  deleted?: boolean
  roles?: ReturnType<typeof tableTwinRoles>
}

/** A table can contribute many items to one call. Keep its positions and roles
 * only for this immutable document snapshot. */
function reviewBlockLookup(doc: ProseMirrorNode) {
  const blocks = new Map<number, ReviewBlock | null>()
  return (index: number): ReviewBlock | null => {
    const cached = blocks.get(index)
    if (cached !== undefined) return cached
    const top = topLevel(doc, index)
    const block = top ? { node: top.node, paragraphs: textblocksOf(top.node, top.pos) } : null
    blocks.set(index, block)
    return block
  }
}

export interface ReviseOptions {
  /** the document's source language script test (sourceScriptOf): a paragraph mostly in it is not revised */
  sourceScript?: RegExp | null
}

/** more than half of the letters belong to the source script: plainly not translated yet */
export function looksUntranslated(texts: readonly string[], script: RegExp): boolean {
  let letters = 0
  let source = 0
  for (const ch of texts.join(' ')) {
    if (!/\p{L}/u.test(ch)) continue
    letters++
    if (script.test(ch)) source++
  }
  return letters > 0 && source / letters > 0.5
}

/** keep the segment's own leading and trailing whitespace: a review never moves it */
function keepEdges(current: string, revised: string): string {
  const lead = /^\s*/.exec(current)![0]
  const trail = /\s*$/.exec(current.slice(lead.length))![0]
  return lead + revised.trim() + trail
}

function planParagraph(
  editor: Editor,
  doc: ProseMirrorNode,
  item: ReviseItem,
  options: ReviseOptions,
  lookup: ReturnType<typeof reviewBlockLookup>,
): Plan {
  const where =
    item.paragraph === undefined
      ? `block ${item.index}`
      : `block ${item.index} paragraph ${item.paragraph}`
  const bad = segmentsError(where, item.segments)
  if (bad) return { ok: false, error: bad }
  const top = lookup(item.index)
  if (!top)
    return {
      ok: false,
      error: `${where}: no such block (the document has ${doc.childCount} blocks)`,
    }
  if ((top.deleted ??= isTrackedDeleted(top.node)))
    return { ok: false, error: `${where}: the block is a pending tracked deletion; leave it alone` }
  const blocks = top.paragraphs
  if (!blocks) return { ok: false, error: `${where}: a ${top.node.type.name} block has no text` }
  const inTable = top.node.type.name === 'docTable'
  if (item.paragraph === undefined && inTable && blocks.length > 1)
    return {
      ok: false,
      error: `${where}: a table block needs "paragraph" (the cell paragraph number read_runs lists)`,
    }
  const paragraph = item.paragraph ?? 0
  if (!Number.isInteger(paragraph) || paragraph < 0 || paragraph >= blocks.length)
    return {
      ok: false,
      error: `${where}: no such paragraph (the block has ${blocks.length}); use the paragraph numbers read_runs lists`,
    }
  const block = blocks[paragraph]
  const groups = groupsOf(block.node, block.pos)
  const report: ReviseReport = { index: item.index, changes: 0 }
  if (item.paragraph !== undefined) report.paragraph = item.paragraph
  if (groups.length === 0) return { ok: true, edits: [], report: { ...report, empty: true } }
  const fp = runFingerprint(groups.map((g) => g.text))
  if (item.fp !== fp)
    return {
      ok: false,
      stale: true,
      error: `${where} changed since read_runs (fingerprint mismatch); read it again`,
    }
  // the original of a bilingual pair is never edited
  if (inTable && !top.roles) {
    top.roles = tableTwinRoles(
      editor,
      blocks.map((b) => {
        const g = groupsOf(b.node, b.pos)
        return g.length > 0 ? runFingerprint(g.map((x) => x.text)) : null
      }),
    )
  }
  const role = inTable ? top.roles?.[paragraph] : plainTwinRole(editor, doc, item.index, fp)
  if (role === 'source')
    return {
      ok: false,
      error: `${where}: this is the original text of a bilingual pair; never edit the original (revise its translation next to it)`,
    }
  // italic spans ride along as ranges; the diff and every check use the plain text
  const parsed = item.segments.map(parseItalicSegment)
  if (item.segments.length !== groups.length)
    return {
      ok: false,
      error: `${where}: give exactly one string per segment (${groups.length}, in read_runs order; repeat an unchanged segment as it is), got ${item.segments.length}`,
    }
  if (parsed.every((p) => p.plain.trim() === ''))
    return {
      ok: false,
      error: `${where}: every segment is empty, which would delete the paragraph's text; pass the revised text`,
    }
  if (
    options.sourceScript &&
    looksUntranslated(
      groups.map((g) => g.text),
      options.sourceScript,
    )
  )
    return { ok: true, edits: [], report: { ...report, untranslated: true } }
  const edits: ReviseEdit[] = []
  groups.forEach((group, i) => {
    const next = keepEdges(group.text, parsed[i].plain)
    // an italic-only change of text that stays the same is skipped: a review never restyles
    if (next === group.text) return
    const italics = placeSpans(next, parsed[i])
    const withItalics = (text: string, at: number): { italics?: SpanOffsets } => {
      const own = sliceSpans(italics, at, at + text.length)
      return own.length > 0 ? { italics: own } : {}
    }
    if (group.to - group.from !== group.text.length) {
      // positions do not follow the characters: replace the group as one piece
      edits.push({
        from: group.from,
        to: group.to,
        text: next,
        marks: group.marks,
        ...withItalics(next, 0),
      })
      report.changes++
      return
    }
    // only inserted words take an italic span; the unchanged words around them keep theirs
    let delta = 0
    for (const span of diffSpans(group.text, next)) {
      edits.push({
        from: group.from + span.start,
        to: group.from + span.end,
        text: span.text,
        marks: group.marks,
        ...withItalics(span.text, span.start + delta),
      })
      delta += span.text.length - (span.end - span.start)
      report.changes++
    }
  })
  return { ok: true, edits, report }
}

/**
 * The tracked transaction: a changed span keeps its text, marked deleted, with
 * the new text inserted right after it as an insertion; both carry the review
 * author. Text this same author inserted earlier is replaced for real (a
 * second pass over the same paragraph does not pile up deletions of its own
 * insertions).
 */
function applyRevisionEdits(
  editor: Editor,
  tr: Transaction,
  originals: ReviseEdit[],
  author: string,
): Transaction {
  const edits = originals.map((e) => ({
    ...e,
    from: tr.mapping.map(e.from, 1),
    to: tr.mapping.map(e.to, -1),
  }))
  const schema = editor.schema
  const date = revisionDate()
  const ins = schema.marks.ins.create({ author, date })
  const del = schema.marks.del.create({ author, date })
  // back to front: an edit never shifts the positions of the ones still ahead
  for (const edit of [...edits].sort((a, b) => b.from - a.from || b.to - a.to)) {
    const own = edit.marks.some((m) => m.type.name === 'ins' && m.attrs.author === author)
    if (own) {
      if (edit.text === '') tr.delete(edit.from, edit.to)
      else
        tr.replaceWith(edit.from, edit.to, textNodes(schema, edit.text, edit.marks, edit.italics))
      continue
    }
    if (edit.text !== '')
      tr.insert(edit.to, textNodes(schema, edit.text, ins.addToSet(edit.marks), edit.italics))
    if (edit.to > edit.from) tr.addMark(edit.from, edit.to, del)
  }
  tr.setMeta(TRACK_IGNORE, true)
  return tr
}

export type ReviseOutcome =
  | { ok: true; reports: ReviseReport[]; author: string; stale: string[] }
  | { ok: false; errors: string[]; stale?: true }

/**
 * revise_blocks: every item is checked first and one bad item refuses the
 * whole call with nothing changed; the edits of all items land in one
 * transaction with a history event per reviewed paragraph. Always tracked.
 */
export function applyRevisions(
  editor: Editor,
  items: ReviseItem[],
  track?: AiTrack,
  options: ReviseOptions = {},
  roleEditor: Editor = editor,
): ReviseOutcome {
  const doc = editor.state.doc
  const errors: string[] = []
  const stale: string[] = []
  const reports: ReviseReport[] = []
  const units = new Map<object, (tr: Transaction) => void>()
  const seen = new Set<string>()
  const nested = new NestedTableChanges(doc)
  for (const batch of nestedBatches(items)) {
    const { index, nestedTable } = batch[0]
    const where = `block ${index} nested table ${nestedTable}`
    const ref = nested.locate(index, nestedTable!)
    const top = topLevel(doc, index)
    if (!ref || !top || isTrackedDeleted(top.node)) {
      errors.push(`${where}: no editable nested table at that number; read_runs again`)
      continue
    }
    const draft = draftNestedTable(editor, ref.model)
    const result = applyRevisions(
      draft.editor,
      batch.map((item) => ({ ...item, index: 0, nestedTable: undefined })),
      track,
      options,
      editor,
    )
    const relabel = (message: string) => message.replace(/^block 0/, where)
    if (!result.ok) {
      const target = result.stale ? stale : errors
      target.push(...result.errors.map(relabel))
      continue
    }
    stale.push(...result.stale.map(relabel))
    reports.push(...result.reports.map((report) => ({ ...report, index, nestedTable })))
    const byParagraph = new Map(batch.map((item) => [item.paragraph ?? 0, item]))
    const changed = result.reports.filter((r) => r.changes > 0)
    let previous = ref.model
    let at = 0
    draft.forEachResult(false, (updated) => {
      const report = changed[at++]!
      units.set(byParagraph.get(report.paragraph ?? 0)!, nestedTextUnit(ref, previous, updated))
      previous = updated
    })
  }
  const lookup = reviewBlockLookup(doc)
  for (const item of items) {
    if (item.nestedTable !== undefined) continue
    const key = `${item.index}:${item.paragraph ?? 0}`
    if (seen.has(key)) {
      errors.push(
        `block ${item.index}${item.paragraph === undefined ? '' : ` paragraph ${item.paragraph}`}: listed twice`,
      )
      continue
    }
    seen.add(key)
    const plan = planParagraph(roleEditor, doc, item, options, lookup)
    if (!plan.ok) (plan.stale ? stale : errors).push(plan.error)
    else {
      reports.push(plan.report)
      if (plan.edits.length)
        units.set(item, (tr) => {
          applyRevisionEdits(editor, tr, plan.edits, author)
        })
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  if (stale.length > 0 && reports.length === 0) return { ok: false, errors: stale, stale: true }
  const author = reviewAuthor(track)
  if (units.size) {
    const tr = editor.state.tr
    for (const item of items) {
      const apply = units.get(item)
      if (!apply) continue
      apply(tr)
      finishTranslationUnit(tr)
    }
    tr.setMeta(TRACK_IGNORE, true)
    editor.view.dispatch(tr)
  }
  const updatedDoc = editor.state.doc
  const updated = updatedDoc === doc ? lookup : reviewBlockLookup(updatedDoc)
  for (const report of reports) {
    if (report.empty || report.nestedTable !== undefined) continue
    const block = updated(report.index)?.paragraphs?.[report.paragraph ?? 0]
    if (!block) continue
    const groups = groupsOf(block.node, block.pos)
    if (groups.length > 0) report.fp = runFingerprint(groups.map((g) => g.text))
  }
  return { ok: true, reports, author, stale }
}
