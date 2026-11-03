import type { Editor } from '@tiptap/core'
import type { Mark, Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { Transaction } from '@tiptap/pm/state'
import { TRACK_IGNORE } from '../editor/revisions'
import { REDACT_MARK } from './redact'
import { isTrackedDeleted } from './doc-utils'
import type { AiTrack } from './protocol'

/**
 * Run-preserving translation (read_runs / translate_blocks).
 *
 * replace_blocks rebuilds a block from model HTML and can only hand the new
 * text one paragraph style and one dominant run style, so a translated
 * paragraph lost its mixed run formats, and a whole-range rewrite could drop
 * empty paragraphs and footnote references. Here the model never writes
 * structure: it gets each paragraph's text as numbered segments, one per run
 * of equal formatting, and returns one translated string per segment. The
 * text is swapped inside the existing text nodes, so every mark (the
 * docTextStyle mark with its raw rPr bytes included), every inline atom
 * (footnote references, breaks, pictures) and every paragraph attribute stays
 * as it was.
 *
 * A group is one text node of the paragraph (ProseMirror already merges
 * adjacent text with an equal mark set, which is stricter than equal
 * docTextStyle alone, so a comment or link boundary also splits a group),
 * further split at tab characters. Never part of a group, and never changed:
 * inline atoms, pending tracked deletions, withheld (redacted) spans, field
 * results, symbol glyphs, checkbox glyphs, and whitespace-only runs.
 */

/** top-level text blocks the tools translate directly */
const TEXT_BLOCK_TYPES = new Set(['docParagraph', 'docHeading', 'docListItem'])

/** marks whose text is not prose to translate (field results, glyphs, withheld or deleted text) */
const FIXED_MARK_TYPES = new Set([
  'del',
  REDACT_MARK,
  'docSym',
  'refField',
  'instrField',
  'ctrlCheckbox',
])

/** one paragraph as read_runs reports it */
export interface RunParagraph {
  /** top-level block index */
  index: number
  /** the n-th paragraph inside a table block (document order); absent for a plain paragraph */
  paragraph?: number
  segments?: string[]
  /** fingerprint of the paragraph's segment texts; translate_blocks checks it */
  fp?: string
  /** no translatable text: left as it is */
  empty?: true
  /** not translatable by these tools (an image, a protected block, a pending deletion) */
  skip?: string
}

interface Group {
  /** absolute document positions of the group's text */
  from: number
  to: number
  text: string
  marks: readonly Mark[]
}

const isFixed = (node: ProseMirrorNode): boolean =>
  node.marks.some((m) => FIXED_MARK_TYPES.has(m.type.name))

/** the translatable groups of the textblock starting at `pos` */
function groupsOf(block: ProseMirrorNode, pos: number): Group[] {
  const groups: Group[] = []
  block.forEach((child, offset) => {
    if (!child.isText || isFixed(child)) return
    const start = pos + 1 + offset
    const value = child.text ?? ''
    let at = 0
    for (const part of value.split('\t')) {
      if (part.trim() !== '')
        groups.push({
          from: start + at,
          to: start + at + part.length,
          text: part,
          marks: child.marks,
        })
      at += part.length + 1
    }
  })
  return groups
}

/**
 * A short fingerprint of a paragraph's translatable text (FNV-1a, base 36).
 * read_runs hands it out and translate_blocks checks it, so an index that
 * shifted since the read (an earlier edit in the same turn, a user edit)
 * cannot write a translation into the wrong paragraph.
 */
export function runFingerprint(segments: readonly string[]): string {
  let hash = 0x811c9dc5
  const text = segments.join('\u0001')
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

/** the textblocks of a top-level block with their positions (a table: every cell paragraph) */
function textblocksOf(
  node: ProseMirrorNode,
  pos: number,
): Array<{ node: ProseMirrorNode; pos: number }> | null {
  if (TEXT_BLOCK_TYPES.has(node.type.name)) return [{ node, pos }]
  if (node.type.name !== 'docTable') return null
  const out: Array<{ node: ProseMirrorNode; pos: number }> = []
  node.descendants((child, offset) => {
    if (child.isTextblock) {
      out.push({ node: child, pos: pos + 1 + offset })
      return false
    }
    return true
  })
  return out
}

function topLevel(
  doc: ProseMirrorNode,
  index: number,
): { node: ProseMirrorNode; pos: number } | null {
  if (!Number.isInteger(index) || index < 0 || index >= doc.childCount) return null
  let pos = 0
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize
  return { node: doc.child(index), pos }
}

/** read_runs: the run groups of blocks start..end (inclusive), text only */
export function readRunGroups(editor: Editor, start: number, end: number): RunParagraph[] {
  const doc = editor.state.doc
  const out: RunParagraph[] = []
  for (let index = start; index <= end; index++) {
    const top = topLevel(doc, index)
    if (!top) break
    const { node, pos } = top
    if (isTrackedDeleted(node)) {
      out.push({ index, skip: 'tracked deletion' })
      continue
    }
    const blocks = textblocksOf(node, pos)
    if (!blocks) {
      out.push({ index, skip: String(node.attrs.blockType || node.type.name) })
      continue
    }
    const inTable = node.type.name === 'docTable'
    blocks.forEach((block, paragraph) => {
      const segments = groupsOf(block.node, block.pos).map((g) => g.text)
      // an empty cell paragraph is noise; an empty body paragraph is listed so it is seen and left alone
      if (segments.length === 0) {
        if (!inTable) out.push({ index, empty: true })
        return
      }
      const fp = runFingerprint(segments)
      out.push(inTable ? { index, paragraph, fp, segments } : { index, fp, segments })
    })
  }
  return out
}

/** one paragraph's translation as translate_blocks receives it */
export interface RunTranslationItem {
  index: number
  paragraph?: number
  /** the fingerprint read_runs gave; when present, a mismatch refuses the item */
  fp?: string
  segments: string[]
}

/**
 * Markup in a segment (segments are plain text; the run formatting stays where it is).
 * Real markup only: an element name from HTML (or a namespaced OOXML-style
 * name such as w:t) inside angle brackets, optionally closing, self-closing or
 * with name=value attributes. Angle-bracketed titles and words (<Clear Bamboo>, Korean
 * book titles, even ones that start with a tag name such as <Title of Book>)
 * and comparisons (1 < 2) are prose and pass.
 */
const MARKUP_TAG_NAMES =
  'a|abbr|b|big|blockquote|body|br|caption|center|code|col|colgroup|dd|del|div|dl|dt|em|font|' +
  'h[1-6]|head|hr|html|i|iframe|img|input|ins|kbd|li|link|mark|meta|ol|p|pre|q|s|samp|script|' +
  'small|span|strike|strong|style|sub|sup|table|tbody|td|tfoot|th|thead|title|tr|tt|u|ul|var|' +
  'sel|tool_response'
export const TAG_LIKE = new RegExp(
  `<\\/?(?:(?:${MARKUP_TAG_NAMES})|[a-z][a-z0-9]*:[a-z][a-z0-9-]*)(?:\\s+[a-z_:][\\w:.-]*\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s<>"']+))*\\s*\\/?>`,
  'i',
)

export interface RunTranslationReport {
  index: number
  paragraph?: number
  /** the paragraph has nothing to translate; the segments were ignored */
  empty?: true
  /** fewer segments than groups: the groups past `given` kept their original text */
  incomplete?: { groups: number; given: number }
  /** segments past the group count, appended to the last group */
  extra?: number
  /** groups whose text actually changed */
  changed: number
}

interface Edit {
  from: number
  to: number
  text: string
  marks: readonly Mark[]
  /** the textblock to flag aiChanged (untracked edits) */
  blockPos: number
}

const LEAD = /^\s*/
const TRAIL = /\s*$/

/**
 * The new text of a group, with the edge whitespace settled: a segment that
 * brings its own leading or trailing whitespace keeps it, one that does not
 * gets the original's, so words of neighbouring runs never run together and
 * never double their space.
 */
function settledText(original: string, segment: string): string {
  const core = segment.trim()
  const lead = LEAD.exec(segment)![0] || LEAD.exec(original)![0]
  const trail = core === '' ? '' : TRAIL.exec(segment)![0] || TRAIL.exec(original)![0]
  if (core === '') return lead || TRAIL.exec(original)![0]
  return lead + core + trail
}

/** the minimal range of a group to rewrite: shared edge whitespace stays as it is */
function edgeTrimmed(group: Group, next: string): { from: number; to: number; text: string } {
  let head = 0
  while (
    head < group.text.length &&
    head < next.length &&
    group.text[head] === next[head] &&
    /\s/.test(next[head])
  )
    head++
  let tail = 0
  while (
    tail < group.text.length - head &&
    tail < next.length - head &&
    group.text[group.text.length - 1 - tail] === next[next.length - 1 - tail] &&
    /\s/.test(next[next.length - 1 - tail])
  )
    tail++
  return {
    from: group.from + head,
    to: group.to - tail,
    text: next.slice(head, next.length - tail),
  }
}

function joinExtra(parts: string[]): string {
  return parts.reduce((acc, part) => {
    if (acc === '') return part
    if (/\s$/.test(acc) || /^\s/.test(part)) return acc + part
    return `${acc} ${part}`
  }, '')
}

type PlanResult =
  { ok: true; edits: Edit[]; report: RunTranslationReport } | { ok: false; error: string }

function planParagraph(doc: ProseMirrorNode, item: RunTranslationItem): PlanResult {
  const where =
    item.paragraph === undefined
      ? `block ${item.index}`
      : `block ${item.index} paragraph ${item.paragraph}`
  if (!Array.isArray(item.segments) || item.segments.some((s) => typeof s !== 'string'))
    return { ok: false, error: `${where}: segments must be an array of strings` }
  if (item.segments.some((s) => /[\r\n]/.test(s)))
    return {
      ok: false,
      error: `${where}: a segment contains a line break; segments are plain text inside one run (breaks and tabs between segments stay as they are)`,
    }
  if (item.segments.some((s) => TAG_LIKE.test(s)))
    return {
      ok: false,
      error: `${where}: a segment contains HTML-like tags; give plain translated text only (each segment keeps its own formatting)`,
    }
  const top = topLevel(doc, item.index)
  if (!top)
    return {
      ok: false,
      error: `${where}: no such block (the document has ${doc.childCount} blocks)`,
    }
  if (isTrackedDeleted(top.node))
    return { ok: false, error: `${where}: the block is a pending tracked deletion; leave it alone` }
  const blocks = textblocksOf(top.node, top.pos)
  if (!blocks)
    return { ok: false, error: `${where}: a ${top.node.type.name} block has no text to translate` }
  if (item.paragraph === undefined && top.node.type.name === 'docTable' && blocks.length > 1)
    return {
      ok: false,
      error: `${where}: a table block needs "paragraph" (the cell paragraph number read_runs lists)`,
    }
  const paragraph = item.paragraph ?? 0
  if (!Number.isInteger(paragraph) || paragraph < 0 || paragraph >= blocks.length) {
    return {
      ok: false,
      error: `${where}: no such paragraph (the block has ${blocks.length}); use the paragraph numbers read_runs lists`,
    }
  }
  const block = blocks[paragraph]
  const groups = groupsOf(block.node, block.pos)
  const report: RunTranslationReport = { index: item.index, changed: 0 }
  if (item.paragraph !== undefined) report.paragraph = item.paragraph
  if (groups.length === 0) return { ok: true, edits: [], report: { ...report, empty: true } }
  if (item.fp !== undefined && item.fp !== runFingerprint(groups.map((g) => g.text)))
    return {
      ok: false,
      error: `${where} changed since read_runs (fingerprint mismatch); read it again`,
    }
  // one empty segment is a piece with no counterpart; all of them would delete the paragraph's text
  if (item.segments.length > 0 && item.segments.every((s) => s.trim() === ''))
    return {
      ok: false,
      error: `${where}: every segment is empty, which would delete the paragraph's text; give the translation`,
    }
  let segments = item.segments
  if (segments.length > groups.length) {
    report.extra = segments.length - groups.length
    segments = [
      ...segments.slice(0, groups.length - 1),
      joinExtra(segments.slice(groups.length - 1)),
    ]
  } else if (segments.length < groups.length) {
    report.incomplete = { groups: groups.length, given: segments.length }
  }
  const edits: Edit[] = []
  segments.forEach((segment, i) => {
    const group = groups[i]
    const next = settledText(group.text, segment)
    if (next === group.text) return
    const range = edgeTrimmed(group, next)
    edits.push({ ...range, marks: group.marks, blockPos: block.pos })
    report.changed++
  })
  return { ok: true, edits, report }
}

function revisionDate(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function applyEdits(editor: Editor, edits: Edit[], track?: AiTrack): Transaction {
  const tr = editor.state.tr
  const schema = editor.schema
  // back to front: an edit never shifts the positions of the ones still ahead
  const ordered = [...edits].sort((a, b) => b.from - a.from)
  if (track) {
    const date = revisionDate()
    const ins = schema.marks.ins.create({ author: track.author, date })
    const del = schema.marks.del.create({ author: track.author, date })
    for (const edit of ordered) {
      if (edit.text !== '') tr.insert(edit.to, schema.text(edit.text, ins.addToSet(edit.marks)))
      if (edit.to > edit.from) tr.addMark(edit.from, edit.to, del)
    }
    tr.setMeta(TRACK_IGNORE, true)
    return tr
  }
  const flagged = new Set<number>()
  for (const edit of ordered) {
    if (edit.text === '') tr.delete(edit.from, edit.to)
    else tr.replaceWith(edit.from, edit.to, schema.text(edit.text, edit.marks))
    flagged.add(edit.blockPos)
  }
  // edits in earlier blocks shift a block's start: map the pre-edit position
  for (const before of flagged) {
    const pos = tr.mapping.map(before)
    const block = tr.doc.nodeAt(pos)
    if (block && block.isTextblock && 'aiChanged' in (block.type.spec.attrs ?? {}))
      tr.setNodeMarkup(pos, undefined, { ...block.attrs, aiChanged: true })
  }
  return tr
}

export type RunTranslationOutcome =
  { ok: true; reports: RunTranslationReport[] } | { ok: false; errors: string[] }

/**
 * translate_blocks: every item checked first; one bad item refuses the whole
 * call with nothing changed. The edits of all items land in one transaction
 * (one undo step).
 */
export function applyRunTranslations(
  editor: Editor,
  items: RunTranslationItem[],
  track?: AiTrack,
): RunTranslationOutcome {
  const doc = editor.state.doc
  const errors: string[] = []
  const reports: RunTranslationReport[] = []
  const edits: Edit[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const key = `${item.index}:${item.paragraph ?? 0}`
    if (seen.has(key)) {
      errors.push(
        `block ${item.index}${item.paragraph === undefined ? '' : ` paragraph ${item.paragraph}`}: listed twice`,
      )
      continue
    }
    seen.add(key)
    const plan = planParagraph(doc, item)
    if (!plan.ok) errors.push(plan.error)
    else {
      reports.push(plan.report)
      edits.push(...plan.edits)
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  if (edits.length > 0) editor.view.dispatch(applyEdits(editor, edits, track))
  return { ok: true, reports }
}

export interface RunTranslationResult extends Partial<Omit<RunTranslationReport, 'index'>> {
  ok: boolean
  error?: string
}

/** Translate one paragraph (a table's `paragraph`-th cell paragraph) in place. */
export function applyRunTranslation(
  editor: Editor,
  blockIndex: number,
  segments: string[],
  options: { paragraph?: number; track?: AiTrack } = {},
): RunTranslationResult {
  const outcome = applyRunTranslations(
    editor,
    [
      {
        index: blockIndex,
        segments,
        ...(options.paragraph === undefined ? {} : { paragraph: options.paragraph }),
      },
    ],
    options.track,
  )
  if (!outcome.ok) return { ok: false, error: outcome.errors.join('; ') }
  const { index: _index, ...report } = outcome.reports[0]
  return { ok: true, ...report }
}
