import type { Editor } from '@tiptap/core'
import type { Mark, Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { Transaction } from '@tiptap/pm/state'
import { TRACK_IGNORE } from '../editor/revisions'
import { REDACT_MARK } from './redact'
import { isTrackedDeleted } from './doc-utils'
import type { NoteInfo, NoteRun } from '@genoffice/docx-engine'
import type { AiTrack } from './protocol'
import type { AiNotesAccess, NoteKind } from './note-ops'

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
  /** a whitespace-only run (never a group) is all that lies between this group and the next */
  gapAfter?: boolean
}

/** the gap flags settleTexts takes, one per group */
const gapsOf = (groups: readonly { gapAfter?: boolean }[]): boolean[] =>
  groups.map((g) => g.gapAfter === true)

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
  // blanks (not tabs) between two groups: the separator the model never sees
  for (let i = 0; i + 1 < groups.length; i++) {
    const between = block.textBetween(
      groups[i].to - pos - 1,
      groups[i + 1].from - pos - 1,
      '',
      '\uFFFC',
    )
    if (/^[^\S\t\n]+$/.test(between)) groups[i].gapAfter = true
  }
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
  /** the paragraph's fingerprint after the edit (completion tracking) */
  fp?: string
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

/** text that closes a phrase: a space in front of it is never wanted */
const STARTS_WITH_CLOSING =
  /^[,.;:!?)\]}%\u00BB\u201D\u2019\u3001\u3002\uFF0C\uFF0E\uFF1B\uFF1A\uFF01\uFF1F\uFF09\u3011\u300D\u300F]/

/**
 * The new texts of consecutive groups, with the edge whitespace settled: a
 * segment that brings its own leading or trailing whitespace keeps it, one
 * that does not inherits the original's, so words of neighbouring runs never
 * run together. Whitespace the tool inherits (never whitespace the model wrote)
 * is dropped where it would read wrongly in the translation: before text that
 * starts with closing punctuation (", most likely" after a run that ended in a
 * space in the source) and where two groups would both put a space between them.
 *
 * `gaps[i]` says a whitespace-only run (never part of a group, so never shown
 * to the model) sits between group i and the next one. That run is already the
 * separator, so whitespace the neighbouring segments carry at that seam is
 * dropped. A segment the model left empty has no text and brings no whitespace
 * of its own; the original's trailing space comes back only when the words
 * around it would otherwise run together.
 */
export function settleTexts(
  originals: readonly string[],
  segments: readonly string[],
  gaps: readonly boolean[] = [],
): string[] {
  interface Piece {
    lead: string
    core: string
    trail: string
    leadInherited: boolean
    trailInherited: boolean
    /** whitespace-only or empty segment: its whole text */
    whole?: string
    /** an empty segment: the whitespace the original ended with */
    spare?: string
  }
  const pieces: Piece[] = segments.map((segment, i) => {
    const original = originals[i]
    const core = segment.trim()
    if (core === '') {
      return {
        lead: '',
        core: '',
        trail: '',
        leadInherited: false,
        trailInherited: false,
        whole: segment,
        ...(segment === '' ? { spare: TRAIL.exec(original)![0] } : {}),
      }
    }
    const ownLead = LEAD.exec(segment)![0]
    const ownTrail = TRAIL.exec(segment)![0]
    return {
      lead: ownLead || LEAD.exec(original)![0],
      core,
      trail: ownTrail || TRAIL.exec(original)![0],
      leadInherited: ownLead === '',
      trailInherited: ownTrail === '',
    }
  })
  const realAfter = (i: number): Piece | undefined => {
    for (let j = i + 1; j < pieces.length; j++) if (pieces[j].spare === undefined) return pieces[j]
    return undefined
  }
  // a separator run between groups already is the space at that seam
  gaps.forEach((gap, i) => {
    if (!gap || i >= pieces.length) return
    let before: Piece | undefined
    for (let j = i; j >= 0 && !before; j--) if (pieces[j].spare === undefined) before = pieces[j]
    const after = realAfter(i)
    if (before && before.whole === undefined) before.trail = ''
    if (after && after.whole === undefined) after.lead = ''
  })
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]
    if (piece.whole !== undefined) continue
    if (piece.leadInherited && STARTS_WITH_CLOSING.test(piece.core)) piece.lead = ''
    const real = realAfter(i)
    if (real && piece.trailInherited && STARTS_WITH_CLOSING.test(real.whole ?? real.core)) {
      piece.trail = ''
      continue
    }
    const next = pieces[i + 1]
    if (!next) continue
    const nextText = next.whole ?? next.lead + next.core
    if (
      piece.trail !== '' &&
      /^\s/.test(nextText) &&
      next.leadInherited &&
      next.whole === undefined
    )
      next.lead = ''
    else if (piece.trail !== '' && piece.trailInherited && /^\s/.test(nextText)) piece.trail = ''
  }
  const out = pieces.map((p) => p.whole ?? p.lead + p.core + p.trail)
  // an emptied group gives its original space back only where words would run together
  pieces.forEach((p, i) => {
    if (!p.spare) return
    let beforeIndex = i - 1
    while (beforeIndex >= 0 && out[beforeIndex] === '') beforeIndex--
    let afterIndex = i + 1
    while (afterIndex < pieces.length && out[afterIndex] === '') afterIndex++
    if (beforeIndex < 0 || afterIndex >= pieces.length) return
    const before = out[beforeIndex]
    const after = out[afterIndex]
    const separated = gaps.slice(beforeIndex, afterIndex).some(Boolean)
    if (!separated && !/\s$/.test(before) && !/^\s/.test(after) && !STARTS_WITH_CLOSING.test(after))
      out[i] = p.spare
  })
  return out
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
    if (/\s$/.test(acc) || /^\s/.test(part) || STARTS_WITH_CLOSING.test(part)) return acc + part
    return `${acc} ${part}`
  }, '')
}

/** why a segments array cannot be applied (null: fine) */
function segmentsError(where: string, segments: unknown): string | null {
  if (!Array.isArray(segments) || segments.some((s) => typeof s !== 'string'))
    return `${where}: segments must be an array of strings`
  if (segments.some((s: string) => /[\r\n]/.test(s)))
    return `${where}: a segment contains a line break; segments are plain text inside one run (breaks and tabs between segments stay as they are)`
  if (segments.some((s: string) => TAG_LIKE.test(s)))
    return `${where}: a segment contains HTML-like tags; give plain translated text only (each segment keeps its own formatting)`
  return null
}

/** the segments fitted to the group count: extras appended to the last group, a shortfall reported */
function fitSegments(
  groups: number,
  given: string[],
  report: { extra?: number; incomplete?: { groups: number; given: number } },
): string[] {
  if (given.length > groups) {
    report.extra = given.length - groups
    return [...given.slice(0, groups - 1), joinExtra(given.slice(groups - 1))]
  }
  if (given.length < groups) report.incomplete = { groups, given: given.length }
  return given
}

type PlanResult =
  { ok: true; edits: Edit[]; report: RunTranslationReport } | { ok: false; error: string }

function planParagraph(doc: ProseMirrorNode, item: RunTranslationItem): PlanResult {
  const where =
    item.paragraph === undefined
      ? `block ${item.index}`
      : `block ${item.index} paragraph ${item.paragraph}`
  const bad = segmentsError(where, item.segments)
  if (bad) return { ok: false, error: bad }
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
  const segments = fitSegments(groups.length, item.segments, report)
  const edits: Edit[] = []
  const settled = settleTexts(
    groups.map((g) => g.text),
    segments,
    gapsOf(groups),
  )
  segments.forEach((_segment, i) => {
    const group = groups[i]
    const next = settled[i]
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

function currentFingerprint(doc: ProseMirrorNode, index: number, paragraph: number): string | null {
  const top = topLevel(doc, index)
  const block = top ? textblocksOf(top.node, top.pos)?.[paragraph] : undefined
  if (!block) return null
  const groups = groupsOf(block.node, block.pos)
  return groups.length > 0 ? runFingerprint(groups.map((g) => g.text)) : null
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
  for (const report of reports) {
    if (report.empty) continue
    const fp = currentFingerprint(editor.state.doc, report.index, report.paragraph ?? 0)
    if (fp) report.fp = fp
  }
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

// ---------------------------------------------------------------------------
// Footnotes and endnotes
//
// Notes live outside the ProseMirror document (App state, like comments), as
// NoteInfo: the plain text (paragraphs joined with \n) and the display runs
// (richParas, one array per paragraph). A note paragraph's groups are its
// display runs that carry text; each is swapped in place so the run keeps its
// formatting, and the note's plain text (which the saver patches into the
// original w:t runs) follows. A note whose runs and plain text disagree
// (tracked deletions, a rebuilt note) is handled as one plain segment per
// paragraph, which drops the display runs exactly as edit_note does.
// ---------------------------------------------------------------------------

/** one note paragraph as read_runs lists it with `notes: true` */
export interface NoteRunParagraph {
  note: NoteKind
  id: string
  /** the paragraph's number inside the note; absent for a one-paragraph note */
  paragraph?: number
  fp: string
  segments: string[]
}

interface NoteGroup {
  /** whitespace-only runs (never groups) are all that lies between this group and the next */
  gapAfter?: boolean
  /** index into richParas[paragraph] (rich mode); -1 in plain mode */
  run: number
  text: string
}

interface NoteParagraphGroups {
  paragraph: number
  groups: NoteGroup[]
}

/** the translatable groups of every paragraph of a note, and whether they are display runs */
function noteGroupsOf(note: NoteInfo): { rich: boolean; paragraphs: NoteParagraphGroups[] } {
  const texts = note.text.split('\n')
  const rich = note.richParas
  const consistent =
    !!rich &&
    rich.length === texts.length &&
    rich.every(
      (runs, p) =>
        runs
          .filter((r) => !r.del)
          .map((r) => r.text)
          .join('') === texts[p],
    )
  if (consistent && rich) {
    return {
      rich: true,
      paragraphs: rich.map((runs, paragraph) => {
        const groups: NoteGroup[] = []
        let blanks = false
        runs.forEach((r: NoteRun, run) => {
          if (r.del) return
          if (r.text.trim() === '') {
            if (/^[^\S\t\n]+$/.test(r.text)) blanks = true
            else if (groups.length > 0) groups[groups.length - 1].gapAfter = false
            return
          }
          if (blanks && groups.length > 0) groups[groups.length - 1].gapAfter = true
          blanks = false
          groups.push({ run, text: r.text })
        })
        return { paragraph, groups }
      }),
    }
  }
  return {
    rich: false,
    paragraphs: texts.map((text, paragraph) => ({
      paragraph,
      groups: text.trim() !== '' ? [{ run: -1, text }] : [],
    })),
  }
}

/** read_runs with `notes: true`: every footnote and endnote paragraph that has text */
export function readNoteRuns(access: AiNotesAccess): NoteRunParagraph[] {
  const out: NoteRunParagraph[] = []
  for (const kind of ['footnote', 'endnote'] as const) {
    for (const note of access.list(kind)) {
      const { paragraphs } = noteGroupsOf(note)
      for (const { paragraph, groups } of paragraphs) {
        if (groups.length === 0) continue
        const segments = groups.map((g) => g.text)
        out.push({
          note: kind,
          id: note.id,
          ...(paragraphs.length > 1 ? { paragraph } : {}),
          fp: runFingerprint(segments),
          segments,
        })
      }
    }
  }
  return out
}

/** one note paragraph's translation as translate_blocks receives it */
export interface NoteTranslationItem {
  note: NoteKind
  id: string
  paragraph?: number
  fp?: string
  segments: string[]
}

export interface NoteTranslationReport {
  note: NoteKind
  id: string
  paragraph?: number
  empty?: true
  incomplete?: { groups: number; given: number }
  extra?: number
  changed: number
  fp?: string
}

export type NotePlanOutcome =
  | { ok: true; reports: NoteTranslationReport[]; next: Array<{ kind: NoteKind; note: NoteInfo }> }
  | { ok: false; errors: string[] }

/**
 * Check every note item and compute the notes' next state without touching
 * anything; the caller commits `next` once the body part went through, so one
 * bad item refuses the whole call with nothing changed.
 */
export function planNoteTranslations(
  access: AiNotesAccess,
  items: NoteTranslationItem[],
): NotePlanOutcome {
  const errors: string[] = []
  const reports: NoteTranslationReport[] = []
  const working = new Map<string, { kind: NoteKind; note: NoteInfo }>()
  const seen = new Set<string>()
  for (const item of items) {
    const paragraph = item.paragraph ?? 0
    const where = `${item.note} ${item.id}${item.paragraph === undefined ? '' : ` paragraph ${item.paragraph}`}`
    const key = `${item.note}:${item.id}:${paragraph}`
    if (seen.has(key)) {
      errors.push(`${where}: listed twice`)
      continue
    }
    seen.add(key)
    const bad = segmentsError(where, item.segments)
    if (bad) {
      errors.push(bad)
      continue
    }
    const wkey = `${item.note}:${item.id}`
    const current = working.get(wkey)?.note ?? access.list(item.note).find((n) => n.id === item.id)
    if (!current) {
      errors.push(`${where}: no such note; use the ids read_runs lists with notes:true`)
      continue
    }
    const { rich, paragraphs } = noteGroupsOf(current)
    const target = paragraphs.find((p) => p.paragraph === paragraph)
    if (!target) {
      errors.push(`${where}: no such paragraph (the note has ${paragraphs.length})`)
      continue
    }
    const report: NoteTranslationReport = { note: item.note, id: item.id, changed: 0 }
    if (item.paragraph !== undefined) report.paragraph = item.paragraph
    if (target.groups.length === 0) {
      reports.push({ ...report, empty: true })
      continue
    }
    if (item.fp !== undefined && item.fp !== runFingerprint(target.groups.map((g) => g.text))) {
      errors.push(`${where} changed since read_runs (fingerprint mismatch); read it again`)
      continue
    }
    if (item.segments.length > 0 && item.segments.every((s) => s.trim() === '')) {
      errors.push(
        `${where}: every segment is empty, which would delete the note's text; give the translation`,
      )
      continue
    }
    const segments = fitSegments(target.groups.length, item.segments, report)
    const settled = settleTexts(
      target.groups.map((g) => g.text),
      segments,
      gapsOf(target.groups),
    )
    const richParas = rich ? current.richParas!.map((runs) => runs.map((r) => ({ ...r }))) : null
    const texts = current.text.split('\n')
    settled.forEach((text, i) => {
      const group = target.groups[i]
      if (text !== group.text) report.changed++
      if (richParas) richParas[paragraph][group.run].text = text
      else texts[paragraph] = text
    })
    const next: NoteInfo = { ...current }
    if (richParas) {
      next.richParas = richParas
      next.text = richParas
        .map((runs) =>
          runs
            .filter((r) => !r.del)
            .map((r) => r.text)
            .join(''),
        )
        .join('\n')
    } else {
      delete next.richParas
      next.text = texts.join('\n')
    }
    working.set(wkey, { kind: item.note, note: next })
    report.fp = runFingerprint(
      noteGroupsOf(next)
        .paragraphs.find((p) => p.paragraph === paragraph)!
        .groups.map((g) => g.text),
    )
    reports.push(report)
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, reports, next: [...working.values()] }
}

// ---------------------------------------------------------------------------
// Completion check
// ---------------------------------------------------------------------------

/** fingerprints of paragraphs a translate_blocks call has already handled, per editor */
const handledFingerprints = new WeakMap<object, Set<string>>()

/** remember the paragraphs just submitted, so a later check does not list them as untouched */
export function recordHandled(editor: Editor, fps: Array<string | undefined>): void {
  let set = handledFingerprints.get(editor)
  if (!set) handledFingerprints.set(editor, (set = new Set()))
  for (const fp of fps) if (fp) set.add(fp)
}

const SCRIPT_PATTERNS: Array<{ language: RegExp; script: RegExp }> = [
  { language: /^(ko\b|korea|한국|한국어|한글)/i, script: /[ᄀ-ᇿ㄰-㆏가-힯]/ },
  { language: /^(ja\b|japan|日本|일본)/i, script: /[぀-ヿ一-鿿]/ },
  { language: /^(zh\b|chinese|中文|汉|漢|중국)/i, script: /[一-鿿]/ },
  { language: /^(ru\b|russia|uk\b|ukrain|bg\b|bulgar|러시아)/i, script: /[Ѐ-ӿ]/ },
  { language: /^(ar\b|arabic|fa\b|persian)/i, script: /[؀-ۿ]/ },
  { language: /^(he\b|hebrew)/i, script: /[֐-׿]/ },
  { language: /^(th\b|thai)/i, script: /[฀-๿]/ },
  { language: /^(el\b|greek)/i, script: /[Ͱ-Ͽ]/ },
  { language: /^(hi\b|hindi)/i, script: /[ऀ-ॿ]/ },
]

/** the script test of a source language ("ko", "Korean", ...); null for a Latin-script or unknown language */
export function sourceScriptOf(language: string | undefined): RegExp | null {
  const name = (language ?? '').trim()
  if (name === '') return null
  return SCRIPT_PATTERNS.find((p) => p.language.test(name))?.script ?? null
}

export interface RemainingReport {
  /** body blocks (top-level index, plus the cell paragraph number in a table) still untranslated */
  body: string[]
  /** note paragraphs still untranslated, "footnote 3" / "endnote 2 paragraph 1" */
  notes: string[]
}

/**
 * The paragraphs and notes that still look untranslated. With a source script
 * (a non-Latin source language) that is any paragraph still containing the
 * script; otherwise any paragraph with letters that no translate_blocks call
 * of this editor has handled (its fingerprint is not recorded).
 */
export function remainingUntranslated(
  editor: Editor,
  access: AiNotesAccess | undefined,
  language?: string,
): RemainingReport {
  const script = sourceScriptOf(language)
  const handled = handledFingerprints.get(editor)
  const pending = (segments: string[], fp: string): boolean => {
    const text = segments.join(' ')
    if (script) return script.test(text)
    return /\p{L}/u.test(text) && !handled?.has(fp)
  }
  const body: string[] = []
  const doc = editor.state.doc
  for (const entry of readRunGroups(editor, 0, doc.childCount - 1)) {
    if (!entry.segments || !entry.fp) continue
    if (pending(entry.segments, entry.fp))
      body.push(
        entry.paragraph === undefined
          ? `${entry.index}`
          : `${entry.index} (paragraph ${entry.paragraph})`,
      )
  }
  const notes: string[] = []
  if (access) {
    for (const entry of readNoteRuns(access)) {
      if (pending(entry.segments, entry.fp))
        notes.push(
          `${entry.note} ${entry.id}${entry.paragraph === undefined ? '' : ` paragraph ${entry.paragraph}`}`,
        )
    }
  }
  return { body, notes }
}
