import type { Editor } from '@tiptap/core'
import type { Mark, Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { Transaction } from '@tiptap/pm/state'
import { TableMap } from '@tiptap/pm/tables'
import { TRACK_IGNORE } from '../editor/revisions'
import { REDACT_MARK } from './redact'
import { isTrackedDeleted } from './doc-utils'
import type { NoteInfo, NoteRun, Run, TextboxDisplay } from '@genoffice/docx-engine'
import type { AiTrack } from './protocol'
import type { AiNotesAccess, NoteKind } from './note-ops'
import {
  italicTagError,
  joinParsed,
  parseItalicSegment,
  placeSpans,
  sliceSpans,
  stripItalicTags,
  textNodes,
  type ParsedSegment,
  type SpanOffsets,
} from './italic-spans'

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
export const TEXT_BLOCK_TYPES = new Set(['docParagraph', 'docHeading', 'docListItem'])

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
  /** a text box block: which of its boxes (0-based); `paragraph` is then the paragraph inside that box */
  box?: number
  segments?: string[]
  /** fingerprint of the paragraph's segment texts; translate_blocks checks it */
  fp?: string
  /** a table paragraph: its cell in the visual grid, 0-based "r<row>c<column>" (the anchor of a merged cell) */
  cell?: string
  /** a merged cell: "<columns>x<rows>" it covers */
  span?: string
  /** no translatable text: left as it is. A table cell that is entirely empty is listed once with its "cell" (a free destination for add_bilingual) */
  empty?: true
  /** not translatable by these tools (an image, a protected block, a pending deletion) */
  skip?: string
  /** review reads only: the side of a bilingual pair ("original" has no fp: it is never edited) */
  role?: 'original' | 'translation'
}

export interface Group {
  /** absolute document positions of the group's text */
  from: number
  to: number
  text: string
  marks: readonly Mark[]
  /** a whitespace-only run (never a group) is all that lies between this group and the next */
  gapAfter?: boolean
  /** a whitespace-only run touches this group's start with an inline object (a note mark) before it */
  blankBefore?: boolean
  /** a whitespace-only run touches this group's end with an inline object (a note mark) after it */
  blankAfter?: boolean
}

/** the gap flags settleTexts takes, one per group */
export const gapsOf = (groups: readonly { gapAfter?: boolean }[]): boolean[] =>
  groups.map((g) => g.gapAfter === true)

/** the edge flags settleTexts takes: a blank run already separates the group from an inline object */
export const edgesOf = (groups: readonly Group[]): SettleEdges => ({
  before: groups.map((g) => g.blankBefore === true),
  after: groups.map((g) => g.blankAfter === true),
})

const isFixed = (node: ProseMirrorNode): boolean =>
  node.marks.some((m) => FIXED_MARK_TYPES.has(m.type.name))

/** the translatable groups of the textblock starting at `pos` */
export function groupsOf(block: ProseMirrorNode, pos: number): Group[] {
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
    else {
      // a note mark (or other object) between: a blank run beside the mark is still the only space there
      if (/^[^\S\t\n]/.test(between)) groups[i].blankAfter = true
      if (/[^\S\t\n]$/.test(between)) groups[i + 1].blankBefore = true
    }
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
export function textblocksOf(
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

export function topLevel(
  doc: ProseMirrorNode,
  index: number,
): { node: ProseMirrorNode; pos: number } | null {
  if (!Number.isInteger(index) || index < 0 || index >= doc.childCount) return null
  let pos = 0
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize
  return { node: doc.child(index), pos }
}

// ---------------------------------------------------------------------------
// Bilingual twins (add_bilingual)
//
// add_bilingual keeps the original paragraph and adds its translation next to
// it. The twin is ordinary document content, so the tools remember the pairs
// by fingerprint (original fp -> twin fps, per editor) and recognise them by
// position: a plain paragraph's twin is the next block; a table's twins sit in
// the same table. read_runs lists both sides as skipped, so the model never
// translates a twin again and the completion check never flags either side.
// ---------------------------------------------------------------------------

const twinPairs = new WeakMap<object, Map<string, Set<string>>>()

/**
 * Twins placed at an explicit destination (add_bilingual target): the pair is not
 * recognised by position, so a paragraph counts as an original while its twin text
 * is anywhere in the document, and as a twin while its original is.
 */
const placedPairs = new WeakMap<object, Map<string, Set<string>>>()

/** remember that the paragraph with fingerprint `original` now has a twin with fingerprint `twin` */
export function recordTwins(
  editor: Editor,
  pairs: ReadonlyArray<readonly [string, string]>,
  options: { placed?: boolean } = {},
): void {
  let map = twinPairs.get(editor)
  if (!map) twinPairs.set(editor, (map = new Map()))
  let placed = placedPairs.get(editor)
  if (options.placed && !placed) placedPairs.set(editor, (placed = new Map()))
  for (const [original, twin] of pairs) {
    let set = map.get(original)
    if (!set) map.set(original, (set = new Set()))
    set.add(twin)
    if (options.placed && original !== twin && placed) {
      let anywhere = placed.get(original)
      if (!anywhere) placed.set(original, (anywhere = new Set()))
      anywhere.add(twin)
    }
  }
}

/** the fingerprints of every text paragraph of the document (tables included), per document state */
const docFingerprints = new WeakMap<ProseMirrorNode, Set<string>>()

function fingerprintsOfDoc(doc: ProseMirrorNode): Set<string> {
  const cached = docFingerprints.get(doc)
  if (cached) return cached
  const set = new Set<string>()
  let pos = 0
  doc.forEach((top) => {
    for (const block of textblocksOf(top, pos) ?? []) {
      const groups = groupsOf(block.node, block.pos)
      if (groups.length > 0) set.add(runFingerprint(groups.map((g) => g.text)))
    }
    pos += top.nodeSize
  })
  docFingerprints.set(doc, set)
  return set
}

/** the role of a paragraph by explicit placement (its twin or original is anywhere in the document) */
function placedRole(editor: Editor, fp: string): TwinRole | null {
  const placed = placedPairs.get(editor)
  if (!placed || placed.size === 0) return null
  const present = fingerprintsOfDoc(editor.state.doc)
  const mine = placed.get(fp)
  if (mine && [...mine].some((t) => present.has(t))) return 'source'
  for (const [original, twins] of placed) if (present.has(original) && twins.has(fp)) return 'twin'
  return null
}

/** block indexes may have moved since the model last read them (blocks were inserted by add_bilingual) */
const shiftedSinceRead = new WeakSet<object>()
export const noteBlocksShifted = (editor: Editor): void => void shiftedSinceRead.add(editor)
export const blocksShifted = (editor: Editor): boolean => shiftedSinceRead.has(editor)

/** true once add_bilingual has added a twin in this editor */
export function hasTwins(editor: Editor): boolean {
  return (twinPairs.get(editor)?.size ?? 0) > 0
}

export type TwinRole = 'source' | 'twin'

const blockFp = (doc: ProseMirrorNode, index: number): string | null => {
  const top = topLevel(doc, index)
  if (!top || !TEXT_BLOCK_TYPES.has(top.node.type.name)) return null
  const groups = groupsOf(top.node, top.pos)
  return groups.length > 0 ? runFingerprint(groups.map((g) => g.text)) : null
}

/** the twin role of the plain paragraph at `index` (its neighbours decide), or null */
export function plainTwinRole(
  editor: Editor,
  doc: ProseMirrorNode,
  index: number,
  fp: string,
): TwinRole | null {
  const pairs = twinPairs.get(editor)
  if (!pairs || pairs.size === 0) return null
  const prev = blockFp(doc, index - 1)
  if (prev && pairs.get(prev)?.has(fp)) return 'twin'
  const next = blockFp(doc, index + 1)
  if (next && pairs.get(fp)?.has(next)) return 'source'
  return placedRole(editor, fp)
}

/** the twin roles of a table's paragraphs (null for text without a twin relation), by fingerprint inside the table */
export function tableTwinRoles(
  editor: Editor,
  fps: ReadonlyArray<string | null>,
): Array<TwinRole | null> {
  const pairs = twinPairs.get(editor)
  if (!pairs || pairs.size === 0) return fps.map(() => null)
  const present = new Set(fps.filter((f): f is string => f !== null))
  return fps.map((fp) => {
    if (fp === null) return null
    const mine = pairs.get(fp)
    if (mine && [...mine].some((t) => present.has(t))) return 'source'
    for (const [original, twins] of pairs) if (present.has(original) && twins.has(fp)) return 'twin'
    return placedRole(editor, fp)
  })
}

const TWIN_SKIP: Record<TwinRole, string> = {
  source: 'already has its bilingual translation (added by add_bilingual); leave it',
  twin: 'the bilingual translation added by add_bilingual; leave it',
}

interface CellInfo {
  cell: string
  span?: string
  /** every paragraph of the cell is empty (no text, no inline object) */
  empty: boolean
  /** absolute position of the cell's first textblock */
  firstPos: number
}

/** the grid cell of each directly nested textblock of a table, by absolute position (nested tables are left out) */
function cellInfoOf(table: ProseMirrorNode, tablePos: number): Map<number, CellInfo> {
  const out = new Map<number, CellInfo>()
  let map: TableMap
  try {
    map = TableMap.get(table)
  } catch {
    return out
  }
  const seen = new Set<number>()
  for (const rel of map.map) {
    if (seen.has(rel)) continue
    seen.add(rel)
    const cell = table.nodeAt(rel)
    if (!cell) continue
    const rect = map.findCell(rel)
    const cols = rect.right - rect.left
    const rows = rect.bottom - rect.top
    let empty = true
    cell.forEach((child) => {
      if (!child.isTextblock || child.childCount > 0) empty = false
    })
    let firstPos = -1
    cell.forEach((child, offset) => {
      if (!child.isTextblock) return
      const abs = tablePos + 1 + rel + 1 + offset
      if (firstPos < 0) firstPos = abs
      out.set(abs, {
        cell: `r${rect.top}c${rect.left}`,
        ...(cols > 1 || rows > 1 ? { span: `${cols}x${rows}` } : {}),
        empty,
        firstPos,
      })
    })
  }
  return out
}

/** the anchored text boxes a `docProtected` block displays (their paragraphs hold the runs), or null */
function textboxesOf(node: ProseMirrorNode): TextboxDisplay[] | null {
  if (node.type.name !== 'docProtected') return null
  const boxes = node.attrs.textboxes as unknown
  return Array.isArray(boxes) && boxes.length > 0 ? (boxes as TextboxDisplay[]) : null
}

interface BoxGroup {
  /** index into the paragraph's runs */
  run: number
  text: string
  /** whitespace-only runs (never groups) are all that lies between this group and the next */
  gapAfter?: boolean
}

/** the translatable groups of one text box paragraph: every run that carries more than blanks */
function boxGroupsOf(runs: readonly Run[]): BoxGroup[] {
  const groups: BoxGroup[] = []
  let blanks = false
  runs.forEach((r, run) => {
    if (r.text.trim() === '') {
      if (/^[^\S\t\n]+$/.test(r.text)) blanks = true
      return
    }
    if (blanks && groups.length > 0) groups[groups.length - 1].gapAfter = true
    blanks = false
    groups.push({ run, text: r.text })
  })
  return groups
}

/** read_runs lines for the paragraphs of a block's text boxes (a read-only box is listed once, as skipped) */
function boxRunEntries(index: number, boxes: readonly TextboxDisplay[]): RunParagraph[] {
  const out: RunParagraph[] = []
  boxes.forEach((box, boxIndex) => {
    const listed = box.paras.map((p) => boxGroupsOf(p.runs).map((g) => g.text))
    if (box.readOnly) {
      if (listed.some((segments) => segments.length > 0))
        out.push({ index, box: boxIndex, skip: 'read-only text box' })
      return
    }
    listed.forEach((segments, paragraph) => {
      if (segments.length === 0) return
      out.push({ index, box: boxIndex, paragraph, fp: runFingerprint(segments), segments })
    })
  })
  return out
}

/** read_runs: the run groups of blocks start..end (inclusive), text only */
export function readRunGroups(
  editor: Editor,
  start: number,
  end: number,
  options: { review?: boolean } = {},
): RunParagraph[] {
  const doc = editor.state.doc
  const out: RunParagraph[] = []
  shiftedSinceRead.delete(editor)
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
      const boxes = textboxesOf(node)
      if (boxes) out.push(...boxRunEntries(index, boxes))
      else out.push({ index, skip: String(node.attrs.blockType || node.type.name) })
      continue
    }
    const inTable = node.type.name === 'docTable'
    const listed = blocks.map((block) => groupsOf(block.node, block.pos).map((g) => g.text))
    const fps = listed.map((segments) => (segments.length > 0 ? runFingerprint(segments) : null))
    const roles = inTable ? tableTwinRoles(editor, fps) : []
    const cells = inTable ? cellInfoOf(node, pos) : null
    blocks.forEach((block, paragraph) => {
      const segments = listed[paragraph]
      const ci = cells?.get(block.pos)
      const cellFields = ci ? { cell: ci.cell, ...(ci.span ? { span: ci.span } : {}) } : {}
      // an empty cell paragraph is noise, except a wholly empty cell (listed once: a free destination);
      // an empty body paragraph is listed so it is seen and left alone
      if (segments.length === 0) {
        if (!inTable) out.push({ index, empty: true })
        else if (ci?.empty && ci.firstPos === block.pos)
          out.push({ index, ...cellFields, empty: true })
        return
      }
      const fp = fps[paragraph]!
      const role = inTable ? roles[paragraph] : plainTwinRole(editor, doc, index, fp)
      if (role && options.review) {
        // a review lists both sides: the twin is what gets revised, the original is read-only (no fp)
        const where = inTable ? { index, paragraph, ...cellFields } : { index }
        out.push(
          role === 'twin'
            ? { ...where, role: 'translation', fp, segments }
            : { ...where, role: 'original', segments },
        )
        return
      }
      if (role) {
        out.push(
          inTable
            ? { index, paragraph, ...cellFields, skip: TWIN_SKIP[role] }
            : { index, skip: TWIN_SKIP[role] },
        )
        return
      }
      out.push(
        inTable ? { index, paragraph, ...cellFields, fp, segments } : { index, fp, segments },
      )
    })
  }
  return out
}

/** one paragraph's translation as translate_blocks receives it */
export interface RunTranslationItem {
  index: number
  /** a text box paragraph: the box inside the block (`paragraph` is the paragraph inside that box) */
  box?: number
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
  /** a text box paragraph: the box inside the block */
  box?: number
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
  /** italic spans (character offsets in `text`) added on top of `marks` */
  italics?: SpanOffsets
}

const LEAD = /^\s*/
const TRAIL = /\s*$/

/** text that closes a phrase: a space in front of it is never wanted */
export const STARTS_WITH_CLOSING =
  /^[,.;:!?)\]}%\u00BB\u201D\u2019\u3001\u3002\uFF0C\uFF0E\uFF1B\uFF1A\uFF01\uFF1F\uFF09\u3011\u300D\u300F]/

/** per group: a blank run already separates it from an inline object before / after it */
export interface SettleEdges {
  before?: readonly boolean[]
  after?: readonly boolean[]
}

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
  edges: SettleEdges = {},
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
  // a blank run beside a note mark is the space there: the segment adds none
  edges.before?.forEach((flag, i) => {
    if (flag && pieces[i] && pieces[i].whole === undefined) pieces[i].lead = ''
  })
  edges.after?.forEach((flag, i) => {
    if (flag && pieces[i] && pieces[i].whole === undefined) pieces[i].trail = ''
  })
  // a whitespace-only segment beside a blank run would only double that space
  pieces.forEach((piece, i) => {
    if (piece.whole === undefined || piece.whole === '') return
    if (gaps[i] || gaps[i - 1] || edges.before?.[i] || edges.after?.[i]) piece.whole = ''
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
  return tidySpacing(out)
}

/**
 * Stray-space clean-up of the settled texts, run on every translate_blocks
 * item so the model never has to repair spacing with find-and-replace.
 * Only ASCII spaces are touched, and only where the result cannot be wrong
 * in any target language: two spaces become one, and a space before a comma,
 * a full stop or a closing round/square bracket is dropped (a full stop that
 * starts an ellipsis, a file extension or a name such as .NET is kept).
 * Marks that some languages set off with a space (French ; : ! ? and the
 * guillemets, German or French %) and any no-break space are never touched,
 * so the tool needs to know nothing about the target language. The same
 * rules apply across a segment seam; whitespace-only segments stay as they are.
 */
const CLOSER_AFTER_SPACE = /^[,)\]]|^\.(?![.\w])/
export function tidySpacing(texts: string[]): string[] {
  const out = texts.map((t) =>
    t.trim() === '' ? t : t.replace(/ {2,}/g, ' ').replace(/ +(?=[,)\]]|\.(?![.\w]))/g, ''),
  )
  for (let i = 0; i < out.length; i++) {
    if (out[i].trim() === '' || !out[i].endsWith(' ')) continue
    let j = i + 1
    while (j < out.length && out[j] === '') j++
    if (j >= out.length || out[j].trim() === '') continue
    const next = out[j]
    if (CLOSER_AFTER_SPACE.test(next.replace(/^ +/, ''))) out[i] = out[i].replace(/ +$/, '')
    else if (next.startsWith(' ')) out[j] = next.replace(/^ +/, '')
  }
  return out
}

/**
 * Whitespace-only runs that would leave a space before a comma, full stop or
 * closing bracket: a run between groups (flagged in `gaps`) followed, past
 * groups the translation emptied, by settled text that starts with such a
 * mark. The segments cannot carry that space away, so the run itself goes.
 * Returns the indexes `i` of the gaps (between group i and group i + 1).
 */
export function gapRunsBeforeClosers(
  settled: readonly string[],
  gaps: readonly boolean[],
): number[] {
  const drop: number[] = []
  for (let j = 0; j < settled.length; j++) {
    if (!CLOSER_AFTER_SPACE.test(settled[j])) continue
    // the blank runs between the previous settled text and this one
    let k = j - 1
    while (k >= 0 && settled[k] === '') k--
    if (k < 0 || /\s$/.test(settled[k])) continue
    for (let g = k; g < j; g++) if (gaps[g]) drop.push(g)
  }
  return drop
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
export function segmentsError(where: string, segments: unknown): string | null {
  if (!Array.isArray(segments) || segments.some((s) => typeof s !== 'string'))
    return `${where}: segments must be an array of strings`
  if (segments.some((s: string) => /[\r\n]/.test(s)))
    return `${where}: a segment contains a line break; segments are plain text inside one run (breaks and tabs between segments stay as they are)`
  for (const s of segments as string[]) {
    const wrong = italicTagError(s)
    if (wrong)
      return `${where}: ${wrong}; the only tag allowed in a segment is a flat <i>…</i> (no attributes, no nesting)`
  }
  if (segments.some((s: string) => TAG_LIKE.test(stripItalicTags(s))))
    return `${where}: a segment contains HTML-like tags; give plain translated text only (each segment keeps its own formatting)`
  return null
}

/** the segments fitted to the group count: extras appended to the last group, a shortfall reported */
export function fitSegments(
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

/**
 * `fitSegments` for segments that may carry italic spans: the plain texts are fitted and
 * the spans of segments joined into the last group follow their text.
 */
export function fitParsed(
  groups: number,
  given: readonly ParsedSegment[],
  report: { extra?: number; incomplete?: { groups: number; given: number } },
): ParsedSegment[] {
  const plain = fitSegments(
    groups,
    given.map((g) => g.plain),
    report,
  )
  if (given.length <= groups)
    return plain.map((text, i) => ({ plain: text, spans: given[i].spans }))
  const head = given.slice(0, groups - 1)
  const tail = joinParsed(given.slice(groups - 1), plain[groups - 1])
  return [...head.map((g, i) => ({ plain: plain[i], spans: g.spans })), tail]
}

type PlanResult =
  | { ok: true; edits: Edit[]; report: RunTranslationReport }
  | { ok: false; error: string; stale?: true }

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
      stale: true,
      error: `${where} changed since read_runs (fingerprint mismatch); read it again`,
    }
  // italic spans ride along as ranges; everything below works on the plain text
  const parsed = item.segments.map(parseItalicSegment)
  // one empty segment is a piece with no counterpart; all of them would delete the paragraph's text
  if (parsed.length > 0 && parsed.every((p) => p.plain.trim() === ''))
    return {
      ok: false,
      error: `${where}: every segment is empty, which would delete the paragraph's text; give the translation`,
    }
  const fitted = fitParsed(groups.length, parsed, report)
  const segments = fitted.map((p) => p.plain)
  const edits: Edit[] = []
  const settled = settleTexts(
    groups.map((g) => g.text),
    segments,
    gapsOf(groups),
    edgesOf(groups),
  )
  for (const g of gapRunsBeforeClosers(settled, gapsOf(groups))) {
    if (g + 1 >= groups.length) continue
    edits.push({
      from: groups[g].to,
      to: groups[g + 1].from,
      text: '',
      marks: [],
      blockPos: block.pos,
    })
    report.changed++
  }
  segments.forEach((_segment, i) => {
    const group = groups[i]
    const next = settled[i]
    if (next === group.text) return
    const range = edgeTrimmed(group, next)
    const offset = range.from - group.from
    const italics = sliceSpans(placeSpans(next, fitted[i]), offset, offset + range.text.length)
    edits.push({
      ...range,
      marks: group.marks,
      blockPos: block.pos,
      ...(italics.length > 0 ? { italics } : {}),
    })
    report.changed++
  })
  return { ok: true, edits, report }
}

/** the new runs of one text box paragraph, written back into the block's `textboxes` attribute */
interface BoxEdit {
  blockPos: number
  box: number
  paragraph: number
  runs: Run[]
}

type BoxPlanResult =
  | { ok: true; edit: BoxEdit | null; report: RunTranslationReport }
  | { ok: false; error: string; stale?: true }

function planBoxParagraph(doc: ProseMirrorNode, item: RunTranslationItem): BoxPlanResult {
  const where = `block ${item.index} box ${item.box} paragraph ${item.paragraph}`
  const bad = segmentsError(where, item.segments)
  if (bad) return { ok: false, error: bad }
  const top = topLevel(doc, item.index)
  if (!top)
    return {
      ok: false,
      error: `${where}: no such block (the document has ${doc.childCount} blocks)`,
    }
  const boxes = textboxesOf(top.node)
  if (!boxes) return { ok: false, error: `${where}: the block has no text box` }
  const box = boxes[item.box as number]
  if (!box)
    return {
      ok: false,
      error: `${where}: no such text box (the block has ${boxes.length}); use the box numbers read_runs lists`,
    }
  if (box.readOnly)
    return { ok: false, error: `${where}: this text box is read-only (it holds a table); leave it` }
  if (!Number.isInteger(item.paragraph))
    return {
      ok: false,
      error: `${where}: a text box entry needs "paragraph" (the number read_runs lists)`,
    }
  const para = box.paras[item.paragraph as number]
  if (!para)
    return {
      ok: false,
      error: `${where}: no such paragraph (the box has ${box.paras.length}); use the numbers read_runs lists`,
    }
  const report: RunTranslationReport = {
    index: item.index,
    box: item.box,
    paragraph: item.paragraph,
    changed: 0,
  }
  const groups = boxGroupsOf(para.runs)
  if (groups.length === 0) return { ok: true, edit: null, report: { ...report, empty: true } }
  if (item.fp !== undefined && item.fp !== runFingerprint(groups.map((g) => g.text)))
    return {
      ok: false,
      stale: true,
      error: `${where} changed since read_runs (fingerprint mismatch); read it again`,
    }
  // a text box run takes plain text: italic spans cannot ride along here
  const plain = item.segments.map((segment) => parseItalicSegment(segment).plain)
  if (plain.length > 0 && plain.every((text) => text.trim() === ''))
    return {
      ok: false,
      error: `${where}: every segment is empty, which would delete the paragraph's text; give the translation`,
    }
  const segments = fitSegments(groups.length, plain, report)
  const settled = settleTexts(
    groups.map((g) => g.text),
    segments,
    groups.map((g) => g.gapAfter === true),
  )
  const runs = para.runs.map((r) => ({ ...r }))
  groups.forEach((group, i) => {
    const next = settled[i]
    if (next === group.text) return
    runs[group.run] = { ...runs[group.run], text: next }
    report.changed++
  })
  report.fp = runFingerprint(boxGroupsOf(runs).map((g) => g.text))
  return {
    ok: true,
    edit:
      report.changed > 0
        ? { blockPos: top.pos, box: item.box as number, paragraph: item.paragraph as number, runs }
        : null,
    report,
  }
}

/** put the new runs into the blocks' `textboxes` attributes; positions are mapped through the edits already in `tr` */
function applyBoxEdits(tr: Transaction, edits: readonly BoxEdit[]): void {
  const byBlock = new Map<number, BoxEdit[]>()
  for (const edit of edits)
    byBlock.set(edit.blockPos, [...(byBlock.get(edit.blockPos) ?? []), edit])
  for (const [blockPos, list] of byBlock) {
    const pos = tr.mapping.map(blockPos)
    const node = tr.doc.nodeAt(pos)
    const boxes = node ? textboxesOf(node) : null
    if (!node || !boxes) continue
    const next = boxes.map((box) => ({ ...box, paras: box.paras.map((p) => ({ ...p })) }))
    for (const edit of list) next[edit.box].paras[edit.paragraph].runs = edit.runs
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, textboxes: next })
  }
}

export function revisionDate(): string {
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
      if (edit.text !== '')
        tr.insert(edit.to, textNodes(schema, edit.text, ins.addToSet(edit.marks), edit.italics))
      if (edit.to > edit.from) tr.addMark(edit.from, edit.to, del)
    }
    tr.setMeta(TRACK_IGNORE, true)
    return tr
  }
  const flagged = new Set<number>()
  for (const edit of ordered) {
    if (edit.text === '') tr.delete(edit.from, edit.to)
    else tr.replaceWith(edit.from, edit.to, textNodes(schema, edit.text, edit.marks, edit.italics))
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
  | {
      ok: true
      reports: RunTranslationReport[]
      /** items skipped because their paragraph changed since read_runs (the rest was applied) */
      stale: string[]
    }
  | { ok: false; errors: string[] }

/**
 * translate_blocks: every item checked first; an invalid item refuses the whole
 * call with nothing changed, while an item whose fingerprint no longer matches
 * is skipped and reported (all stale: refused). The edits of all items land in one transaction
 * (one undo step).
 */
export function applyRunTranslations(
  editor: Editor,
  items: RunTranslationItem[],
  track?: AiTrack,
): RunTranslationOutcome {
  const doc = editor.state.doc
  const errors: string[] = []
  const stale: string[] = []
  const reports: RunTranslationReport[] = []
  const edits: Edit[] = []
  const boxEdits: BoxEdit[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const isBox = item.box !== undefined
    const key = `${item.index}:${isBox ? `box${item.box}:` : ''}${item.paragraph ?? 0}`
    if (seen.has(key)) {
      errors.push(
        `block ${item.index}${isBox ? ` box ${item.box}` : ''}${item.paragraph === undefined ? '' : ` paragraph ${item.paragraph}`}: listed twice`,
      )
      continue
    }
    seen.add(key)
    if (isBox) {
      if (track) {
        errors.push(
          `block ${item.index} box ${item.box}: a text box cannot carry tracked changes; use translate_blocks without revision tracking`,
        )
        continue
      }
      const plan = planBoxParagraph(doc, item)
      if (!plan.ok) (plan.stale ? stale : errors).push(plan.error)
      else {
        reports.push(plan.report)
        if (plan.edit) boxEdits.push(plan.edit)
      }
      continue
    }
    const plan = planParagraph(doc, item)
    if (!plan.ok) (plan.stale ? stale : errors).push(plan.error)
    else {
      reports.push(plan.report)
      edits.push(...plan.edits)
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  if (stale.length > 0 && reports.length === 0) return { ok: false, errors: stale }
  if (edits.length > 0 || boxEdits.length > 0) {
    const tr = edits.length > 0 ? applyEdits(editor, edits, track) : editor.state.tr
    if (boxEdits.length > 0) applyBoxEdits(tr, boxEdits)
    editor.view.dispatch(tr)
  }
  for (const report of reports) {
    if (report.empty || report.box !== undefined) continue
    const fp = currentFingerprint(editor.state.doc, report.index, report.paragraph ?? 0)
    if (fp) report.fp = fp
  }
  return { ok: true, reports, stale }
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
    // notes live outside the document model: italic tags are dropped, the text stays plain
    const plainSegments = item.segments.map(stripItalicTags)
    if (plainSegments.length > 0 && plainSegments.every((s) => s.trim() === '')) {
      errors.push(
        `${where}: every segment is empty, which would delete the note's text; give the translation`,
      )
      continue
    }
    const segments = fitSegments(target.groups.length, plainSegments, report)
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
        entry.box !== undefined
          ? `${entry.index} (box ${entry.box} paragraph ${entry.paragraph})`
          : entry.paragraph === undefined
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
