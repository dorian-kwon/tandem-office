import { applySlotRoles, bilingualSlots } from './bilingual-table-slots'
import {
  AddMarkStep,
  AttrStep,
  RemoveMarkStep,
  ReplaceAroundStep,
  type Step,
} from '@tiptap/pm/transform'
import { noteParagraph, type NoteUnit } from './note-translation-history'
import { finishTranslationUnit } from '../editor/translation-history'
import { originalAiEditor } from './ai-history-gate'
import type { Editor } from '@tiptap/core'
import type { Mark, Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { Transaction } from '@tiptap/pm/state'
import { TableMap } from '@tiptap/pm/tables'
import { TRACK_IGNORE } from '../editor/revisions'
import { REDACT_MARK } from './redact'
import { isTrackedDeleted } from './doc-utils'
import type { NoteInfo, NoteRun, Run, TextboxDisplay } from '@genoffice/docx-engine'
import type { CellBox } from '../editor/cell-box-segments'
import { shrinkBoxToFit } from './box-fit'
import {
  draftNestedTable,
  NestedTableChanges,
  nestedTextUnit,
  nestedBatches,
  nestedTableNode,
  nestedTablesOf,
} from './nested-table-draft'
import { parseTagged, taggedViewOf } from './tagged-runs'
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
  /** depth-first number of a nested table in this block */
  nestedTable?: number
  /** the n-th paragraph inside a table block (document order); absent for a plain paragraph */
  paragraph?: number
  /** a text box block: which of its boxes (0-based); `paragraph` is then the paragraph inside that box */
  box?: number
  segments?: string[]
  /**
   * a paragraph of mixed formatting as one sentence, a numbered tag around each stretch of one
   * formatting: translate it whole with `tagged` instead of run by run (see tagged-runs.ts)
   */
  tagged?: string
  /** what each tag number of `tagged` means */
  tags?: Record<string, string>
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

type LocatedBlock = { node: ProseMirrorNode; pos: number }
const tableParagraphs = new WeakMap<ProseMirrorNode, { pos: number; blocks: LocatedBlock[] }>()

/** the textblocks of a top-level block with their positions (a table: every cell paragraph) */
export function textblocksOf(
  node: ProseMirrorNode,
  pos: number,
): Array<{ node: ProseMirrorNode; pos: number }> | null {
  if (TEXT_BLOCK_TYPES.has(node.type.name)) return [{ node, pos }]
  if (node.type.name !== 'docTable') return null
  const cached = tableParagraphs.get(node)
  if (cached?.pos === pos) return cached.blocks
  const out: LocatedBlock[] = []
  node.descendants((child, offset) => {
    if (child.isTextblock) {
      out.push({ node: child, pos: pos + 1 + offset })
      return false
    }
    return true
  })
  tableParagraphs.set(node, { pos, blocks: out })
  return out
}

const topOffsets = new WeakMap<ProseMirrorNode, number[]>()
export function topLevel(
  doc: ProseMirrorNode,
  index: number,
): { node: ProseMirrorNode; pos: number } | null {
  if (!Number.isInteger(index) || index < 0 || index >= doc.childCount) return null
  let offsets = topOffsets.get(doc)
  if (!offsets) {
    offsets = []
    doc.forEach((_node, pos) => offsets!.push(pos))
    topOffsets.set(doc, offsets)
  }
  return { node: doc.child(index), pos: offsets[index]! }
}

// ---------------------------------------------------------------------------
// Bilingual twins (add_bilingual)
//
// Table layouts retain fingerprints for detached table drafts. Individual body
// paragraphs and explicitly placed translations retain their own node identities.
// ---------------------------------------------------------------------------

const twinPairs = new WeakMap<object, Map<string, Set<string>>>()

export function recordTwins(editor: Editor, pairs: ReadonlyArray<readonly [string, string]>): void {
  let map = twinPairs.get(originalAiEditor(editor))
  if (!map) twinPairs.set(originalAiEditor(editor), (map = new Map()))
  for (const [original, twin] of pairs) {
    let set = map.get(original)
    if (!set) map.set(original, (set = new Set()))
    set.add(twin)
  }
}

/** Pairs found in a detached table edit, to commit with the live editor transaction. */
export function twinPairsOf(editor: Editor): Array<[string, string]> {
  const pairs = twinPairs.get(originalAiEditor(editor))
  if (!pairs) return []
  return [...pairs].flatMap(([source, twins]) =>
    [...twins].map((twin): [string, string] => [source, twin]),
  )
}

/** block indexes may have moved since the model last read them (blocks were inserted by add_bilingual) */
const shiftedSinceRead = new WeakSet<object>()
export const noteBlocksShifted = (editor: Editor): void =>
  void shiftedSinceRead.add(originalAiEditor(editor))
export const blocksShifted = (editor: Editor): boolean =>
  shiftedSinceRead.has(originalAiEditor(editor))

/** true once add_bilingual has added a twin in this editor */
export function hasTwins(editor: Editor): boolean {
  const live = originalAiEditor(editor)
  return pairedNodes.has(live) || (twinPairs.get(live)?.size ?? 0) > 0
}

export type TwinRole = 'source' | 'twin'

interface ParagraphTwin {
  role: TwinRole
  pair: object
  placed: boolean
}

const pairedNodes = new WeakMap<Editor, WeakMap<ProseMirrorNode, ParagraphTwin>>()

const placedInDocument = new WeakMap<Editor, { doc: ProseMirrorNode; complete: Set<object> }>()

/** A far pair is complete while both of its own non-empty paragraphs are present. */
function placedRole(editor: Editor, node: ProseMirrorNode): TwinRole | null {
  const live = originalAiEditor(editor)
  const nodes = pairedNodes.get(live)
  const identity = nodes?.get(node)
  if (!identity?.placed || !nodes) return null
  const doc = editor.state.doc
  let cached = placedInDocument.get(live)
  if (cached?.doc !== doc) {
    const sources = new Set<object>()
    const twins = new Set<object>()
    doc.descendants((child) => {
      if (!child.isTextblock) return
      const entry = child.content.size && nodes.get(child)
      if (entry && entry.placed) (entry.role === 'source' ? sources : twins).add(entry.pair)
      return false
    })
    const complete = new Set([...sources].filter((pair) => twins.has(pair)))
    cached = { doc, complete }
    placedInDocument.set(live, cached)
  }
  return cached.complete.has(identity.pair) ? identity.role : null
}

/** Keep a bilingual pair attached to its two paragraphs when the user edits their text.
 * A split, deletion or replacement of a whole paragraph must not mark its new neighbour. */
export function rememberParagraphTwins(
  editor: Editor,
  pairs: ReadonlyArray<readonly [ProseMirrorNode, ProseMirrorNode]>,
  placed = false,
): void {
  if (!pairs.length) return
  const live = originalAiEditor(editor)
  let nodes = pairedNodes.get(live)
  if (!nodes) {
    const identities = new WeakMap<ProseMirrorNode, ParagraphTwin>()
    nodes = identities
    pairedNodes.set(live, identities)
    live.on('transaction', ({ transaction }) => {
      transaction.mapping.maps.forEach((map, index) => {
        const before = transaction.docs[index]!
        const after = transaction.docs[index + 1] ?? transaction.doc
        const step = transaction.steps[index]
        // Mark steps have an empty position map. Only visit paragraphs touched.
        if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
          before.nodesBetween(step.from, step.to, (node, pos) => {
            if (!node.isTextblock) return
            const identity = identities.get(node)
            const next = identity && after.nodeAt(pos)
            if (identity && next?.isTextblock) identities.set(next, identity)
            return false
          })
        }
        // Changing paragraph attributes replaces its wrapper while keeping all its content.
        const wrapperPos =
          step instanceof AttrStep
            ? step.pos
            : step instanceof ReplaceAroundStep &&
                step.gapFrom === step.from + 1 &&
                step.gapTo === step.to - 1
              ? step.from
              : undefined
        if (wrapperPos !== undefined) {
          const old = before.nodeAt(wrapperPos)
          const next = after.nodeAt(wrapperPos)
          const identity = old && identities.get(old)
          if (identity && next?.isTextblock && old.content.eq(next.content))
            identities.set(next, identity)
        }
        map.forEach((start, end, nextStart, nextEnd) => {
          const old = before.resolve(start)
          if (!old.parent.isTextblock || end > old.end()) return
          const identity = identities.get(old.parent)
          if (!identity) return
          const next = after.resolve(nextStart)
          if (old.depth === next.depth && nextEnd <= next.end() && next.parent.isTextblock)
            identities.set(next.parent, identity)
        })
      })
    })
  }
  placedInDocument.delete(live)
  for (const [source, twin] of pairs) {
    const pair = {}
    nodes.set(source, { pair, role: 'source', placed })
    nodes.set(twin, { pair, role: 'twin', placed })
  }
}

/** the twin role of the plain paragraph at `index` (its neighbours decide), or null */
export function plainTwinRole(
  editor: Editor,
  doc: ProseMirrorNode,
  index: number,
): TwinRole | null {
  const nodes = pairedNodes.get(originalAiEditor(editor))
  const identity = nodes?.get(doc.child(index))
  if (identity?.placed) return placedRole(editor, doc.child(index))
  if (identity) {
    const neighbour = doc.maybeChild(index + (identity.role === 'source' ? 1 : -1))
    if (neighbour?.content.size && nodes?.get(neighbour)?.pair === identity.pair)
      return identity.role
  }
  return null
}

/** the twin roles of a table's paragraphs (null for text without a twin relation), by fingerprint inside the table */
export function tableTwinRoles(
  editor: Editor,
  fps: ReadonlyArray<string | null>,
  blocks: ReadonlyArray<{ node: ProseMirrorNode }>,
): Array<TwinRole | null> {
  const pairs = twinPairs.get(originalAiEditor(editor))
  if (!pairs || pairs.size === 0) return blocks.map((block) => placedRole(editor, block.node))
  const present = new Set(fps.filter((f): f is string => f !== null))
  const sources = new Set<string>()
  const twins = new Set<string>()
  for (const original of present) {
    for (const twin of pairs.get(original) ?? []) {
      if (!present.has(twin)) continue
      sources.add(original)
      twins.add(twin)
    }
  }
  return fps.map((fp, i) => {
    if (fp === null) return null
    if (sources.has(fp)) return 'source'
    if (twins.has(fp)) return 'twin'
    return placedRole(editor, blocks[i]!.node)
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

/** one box of a block and where its text lives */
interface BoxRef {
  /**
   * The number read_runs lists and translate_blocks takes: the box's index in a text box block,
   * or its text segment number in the whole table for a box inside a table cell. Undefined for a
   * cell box that cannot be written back.
   */
  key: number | undefined
  box: TextboxDisplay
  /** absolute position of the node that holds the box, the attribute of it and the index inside */
  nodePos: number
  attr: 'textboxes' | 'boxes'
  at: number
}

/** the boxes of a text box block or of the cells of a table, in document order; null when none */
function boxRefsOf(node: ProseMirrorNode, pos: number): BoxRef[] | null {
  const own = textboxesOf(node)
  if (own) return own.map((box, at) => ({ key: at, box, nodePos: pos, attr: 'textboxes', at }))
  if (node.type.name !== 'docTable') return null
  const refs: BoxRef[] = []
  node.descendants((child, offset) => {
    if (child.type.name !== 'docCellBoxes' || !Array.isArray(child.attrs.boxes)) return true
    ;(child.attrs.boxes as CellBox[]).forEach((box, at) =>
      refs.push({
        key: box.readOnly ? undefined : box.tableSegment,
        box,
        nodePos: pos + 1 + offset,
        attr: 'boxes',
        at,
      }),
    )
    return false
  })
  return refs.length > 0 ? refs : null
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
function boxRunEntries(index: number, refs: readonly BoxRef[]): RunParagraph[] {
  const out: RunParagraph[] = []
  let unwritable = false
  refs.forEach(({ box, key }) => {
    const listed = box.paras.map((p) => boxGroupsOf(p.runs).map((g) => g.text))
    const hasText = listed.some((segments) => segments.length > 0)
    if (key === undefined) {
      // a cell box nothing can be written to (no segment number, or read-only): said once per block
      if (hasText) unwritable = true
      return
    }
    if (box.readOnly) {
      if (hasText) out.push({ index, box: key, skip: 'read-only text box' })
      return
    }
    listed.forEach((segments, paragraph) => {
      if (segments.length === 0) return
      out.push({ index, box: key, paragraph, fp: runFingerprint(segments), segments })
    })
  })
  if (unwritable) out.push({ index, skip: 'text box in a table cell that cannot be written back' })
  return out
}

/** read_runs: the run groups of blocks start..end (inclusive), text only */
export function readRunGroups(
  editor: Editor,
  start: number,
  end: number,
  options: { review?: boolean; compact?: boolean } = {},
): RunParagraph[] {
  const doc = editor.state.doc
  const out: RunParagraph[] = []
  if (!options.compact) shiftedSinceRead.delete(originalAiEditor(editor))
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
      const refs = boxRefsOf(node, pos)
      if (refs) out.push(...boxRunEntries(index, refs))
      else out.push({ index, skip: String(node.attrs.blockType || node.type.name) })
      continue
    }
    out.push(...textRunEntries(editor, doc, node, pos, blocks, index, options))
    const inTable = node.type.name === 'docTable'
    if (inTable) {
      nestedTablesOf(node, pos).forEach(({ model }, nestedTable) => {
        const table = nestedTableNode(editor, model)
        const paragraphs = textblocksOf(table, 0)
        if (paragraphs) {
          out.push(
            ...textRunEntries(editor, doc, table, 0, paragraphs, index, options, model).map(
              (entry) => ({
                ...entry,
                nestedTable,
              }),
            ),
          )
        }
      })
    }
    // text boxes inside the cells of this table (the boxes OCR puts over a picture)
    if (inTable) {
      const refs = boxRefsOf(node, pos)
      if (refs) out.push(...boxRunEntries(index, refs))
    }
  }
  return out
}

// Progress checks visit every paragraph after each AI batch. Reuse the text
// and fingerprint of untouched immutable nodes, even when their offsets move.
const paragraphReads = new WeakMap<ProseMirrorNode, { segments: string[]; fp: string | null }>()
function paragraphRead(node: ProseMirrorNode) {
  let result = paragraphReads.get(node)
  if (!result) {
    const segments = groupsOf(node, 0).map((g) => g.text)
    result = { segments, fp: segments.length ? runFingerprint(segments) : null }
    paragraphReads.set(node, result)
  }
  return result
}

function textRunEntries(
  editor: Editor,
  doc: ProseMirrorNode,
  node: ProseMirrorNode,
  pos: number,
  blocks: NonNullable<ReturnType<typeof textblocksOf>>,
  index: number,
  options: { review?: boolean; compact?: boolean },
  tableModel?: object,
): RunParagraph[] {
  const out: RunParagraph[] = []
  const inTable = node.type.name === 'docTable'
  const paragraphs = blocks.map((block) => paragraphRead(block.node))
  const fps = paragraphs.map((p) => p.fp)
  const slots = inTable ? bilingualSlots(node, tableModel) : undefined
  const roles = inTable ? tableTwinRoles(editor, fps, blocks) : []
  if (slots) applySlotRoles(slots, blocks, roles)
  const cells = inTable && !options.compact ? cellInfoOf(node, pos) : null
  blocks.forEach((block, paragraph) => {
    const segments = paragraphs[paragraph]!.segments
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
    const role = inTable ? roles[paragraph] : plainTwinRole(editor, doc, index)
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
    const view = options.compact
      ? null
      : taggedViewOf(block.node, block.pos, groupsOf(block.node, block.pos), isFixed)
    const tagged = view ? { tagged: view.tagged, tags: view.tags } : {}
    out.push(
      inTable
        ? { index, paragraph, ...cellFields, fp, segments, ...tagged }
        : { index, fp, segments, ...tagged },
    )
  })
  return out
}

/** one paragraph's translation as translate_blocks receives it */
export interface RunTranslationItem {
  index: number
  /** depth-first number of a nested table in this block */
  nestedTable?: number
  /** a text box paragraph: the box inside the block (`paragraph` is the paragraph inside that box) */
  box?: number
  paragraph?: number
  /** the fingerprint read_runs gave; when present, a mismatch refuses the item */
  fp?: string
  /** the translation of each run group, in order (or `tagged`) */
  segments?: string[]
  /** the translation of the whole paragraph with the numbered tags read_runs gave (or `segments`) */
  tagged?: string
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
  /** depth-first number of a nested table in this block */
  nestedTable?: number
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
  /** a tagged translation: these pieces, each with its own marks, replace from..to (`text` is unused) */
  pieces?: Array<{ text: string; marks: readonly Mark[]; italics?: SpanOffsets }>
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

/** a translation written with the numbered tags read_runs gave: the pieces replace the whole run range */
function planTagged(
  item: RunTranslationItem,
  where: string,
  block: { node: ProseMirrorNode; pos: number },
  groups: readonly Group[],
  report: RunTranslationReport,
): PlanResult {
  const view = taggedViewOf(block.node, block.pos, groups, isFixed)
  if (!view)
    return {
      ok: false,
      error: `${where}: read_runs gave no "tagged" text for this paragraph; translate it with "segments"`,
    }
  const parsed = parseTagged(item.tagged as string, view.formats.length)
  if (!parsed.ok) return { ok: false, error: `${where}: ${parsed.error}` }
  const bad = segmentsError(
    where,
    parsed.pieces.map((p) => p.text),
  )
  if (bad) return { ok: false, error: bad }
  const pieces = parsed.pieces.map((p) => {
    const spans = parseItalicSegment(p.text)
    return {
      text: spans.plain,
      marks: view.formats[p.format],
      italics: placeSpans(spans.plain, spans),
    }
  })
  report.changed = 1
  return {
    ok: true,
    edits: [{ from: view.from, to: view.to, text: '', marks: [], blockPos: block.pos, pieces }],
    report,
  }
}

function planParagraph(doc: ProseMirrorNode, item: RunTranslationItem): PlanResult {
  const where =
    item.paragraph === undefined
      ? `block ${item.index}`
      : `block ${item.index} paragraph ${item.paragraph}`
  const bad = item.tagged === undefined ? segmentsError(where, item.segments) : null
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
  if (item.tagged !== undefined) return planTagged(item, where, block, groups, report)
  // italic spans ride along as ranges; everything below works on the plain text
  const parsed = (item.segments as string[]).map(parseItalicSegment)
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
  /** the node holding the box (a text box block, or the cell box node of a table), its attribute and the box index in it */
  nodePos: number
  attr: 'textboxes' | 'boxes'
  at: number
  paragraph: number
  runs: Run[]
}

type BoxPlanResult =
  | { ok: true; edit: BoxEdit | null; report: RunTranslationReport }
  | { ok: false; error: string; stale?: true }

function planBoxParagraph(doc: ProseMirrorNode, item: RunTranslationItem): BoxPlanResult {
  const where = `block ${item.index} box ${item.box} paragraph ${item.paragraph}`
  if (item.tagged !== undefined)
    return { ok: false, error: `${where}: a text box paragraph is translated with "segments"` }
  const bad = segmentsError(where, item.segments)
  if (bad) return { ok: false, error: bad }
  const top = topLevel(doc, item.index)
  if (!top)
    return {
      ok: false,
      error: `${where}: no such block (the document has ${doc.childCount} blocks)`,
    }
  const refs = boxRefsOf(top.node, top.pos)
  if (!refs) return { ok: false, error: `${where}: the block has no text box` }
  const ref = refs.find((r) => r.key === item.box)
  if (!ref)
    return {
      ok: false,
      error: `${where}: no such text box that can be written (use the box numbers read_runs lists)`,
    }
  const box = ref.box
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
  const plain = (item.segments as string[]).map((segment) => parseItalicSegment(segment).plain)
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
        ? {
            nodePos: ref.nodePos,
            attr: ref.attr,
            at: ref.at,
            paragraph: item.paragraph as number,
            runs,
          }
        : null,
    report,
  }
}

/** Measure the box from its original font sizes after each paragraph so the
 * last unit has the same uniform fit as translating the whole box at once. */
function applyBoxEdit(tr: Transaction, edit: BoxEdit, drafts: Map<string, TextboxDisplay>): void {
  const pos = tr.mapping.map(edit.nodePos)
  const node = tr.doc.nodeAt(pos)!
  const boxes = node.attrs[edit.attr] as TextboxDisplay[]
  const key = `${edit.nodePos}:${edit.attr}:${edit.at}`
  const previous = drafts.get(key) ?? boxes[edit.at]!
  const paras = previous.paras.slice()
  paras[edit.paragraph] = { ...paras[edit.paragraph]!, runs: edit.runs }
  const draft = { ...previous, paras }
  drafts.set(key, draft)
  const next = boxes.slice()
  next[edit.at] = shrinkBoxToFit(draft)
  tr.setNodeMarkup(pos, undefined, { ...node.attrs, [edit.attr]: next })
}

export function revisionDate(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function applyEdits(
  editor: Editor,
  tr: Transaction,
  originalEdits: Edit[],
  track?: AiTrack,
): Transaction {
  const edits = originalEdits.map((e) => ({
    ...e,
    from: tr.mapping.map(e.from, 1),
    to: tr.mapping.map(e.to, -1),
  }))
  const schema = editor.schema
  // back to front: an edit never shifts the positions of the ones still ahead
  const ordered = [...edits].sort((a, b) => b.from - a.from)
  if (track) {
    const date = revisionDate()
    const ins = schema.marks.ins.create({ author: track.author, date })
    const del = schema.marks.del.create({ author: track.author, date })
    for (const edit of ordered) {
      if (edit.pieces)
        tr.insert(
          edit.to,
          edit.pieces.flatMap((p) => textNodes(schema, p.text, ins.addToSet(p.marks), p.italics)),
        )
      else if (edit.text !== '')
        tr.insert(edit.to, textNodes(schema, edit.text, ins.addToSet(edit.marks), edit.italics))
      if (edit.to > edit.from) tr.addMark(edit.from, edit.to, del)
    }
    tr.setMeta(TRACK_IGNORE, true)
    return tr
  }
  const flagged = new Set<number>()
  for (const edit of ordered) {
    if (edit.pieces)
      tr.replaceWith(
        edit.from,
        edit.to,
        edit.pieces.flatMap((p) => textNodes(schema, p.text, p.marks, p.italics)),
      )
    else if (edit.text === '') tr.delete(edit.from, edit.to)
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
      /** text box items left untouched because revision tracking is on (a box cannot carry revisions) */
      skippedBoxes: string[]
    }
  | { ok: false; errors: string[]; stale?: true }

/**
 * translate_blocks: every item checked first; an invalid item refuses the whole
 * call with nothing changed, while an item whose fingerprint no longer matches
 * is skipped and reported (all stale: refused). The edits of all items land in one transaction
 * with separate native undo steps for each paragraph.
 */
export function applyRunTranslations(
  editor: Editor,
  items: RunTranslationItem[],
  track?: AiTrack,
  noteSteps: Array<{ afterBody: number; step: Step }> = [],
): RunTranslationOutcome {
  const doc = editor.state.doc
  const errors: string[] = []
  const stale: string[] = []
  const skippedBoxes: string[] = []
  const reports: RunTranslationReport[] = []
  const units = new Map<object, (tr: Transaction) => void>()
  const boxDrafts = new Map<string, TextboxDisplay>()
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
    const outcome = applyRunTranslations(
      draft.editor,
      batch.map((item) => ({ ...item, index: 0, nestedTable: undefined })),
      track,
    )
    if (!outcome.ok) {
      const target = outcome.stale ? stale : errors
      target.push(...outcome.errors.map((error) => error.replace(/^block 0/, where)))
      continue
    }
    stale.push(...outcome.stale.map((error) => error.replace(/^block 0/, where)))
    reports.push(...outcome.reports.map((report) => ({ ...report, index, nestedTable })))
    const byParagraph = new Map(batch.map((item) => [item.paragraph ?? 0, item]))
    const changed = outcome.reports.filter((r) => r.changed > 0)
    let previous = ref.model
    let at = 0
    draft.forEachResult(false, (updated) => {
      const report = changed[at++]!
      units.set(byParagraph.get(report.paragraph ?? 0)!, nestedTextUnit(ref, previous, updated))
      previous = updated
    })
  }
  for (const item of items) {
    if (item.nestedTable !== undefined) continue
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
        skippedBoxes.push(
          `block ${item.index} box ${item.box}: a text box cannot carry tracked changes, so it was left as it is; translate it with revision tracking off`,
        )
        continue
      }
      const plan = planBoxParagraph(doc, item)
      if (!plan.ok) (plan.stale ? stale : errors).push(plan.error)
      else {
        reports.push(plan.report)
        if (plan.edit) units.set(item, (tr) => applyBoxEdit(tr, plan.edit!, boxDrafts))
      }
      continue
    }
    const plan = planParagraph(doc, item)
    if (!plan.ok) (plan.stale ? stale : errors).push(plan.error)
    else {
      reports.push(plan.report)
      if (plan.edits.length)
        units.set(item, (tr) => {
          applyEdits(editor, tr, plan.edits, track)
        })
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  if (stale.length > 0 && reports.length === 0) return { ok: false, errors: stale, stale: true }
  if (skippedBoxes.length > 0 && reports.length === 0) return { ok: false, errors: skippedBoxes }
  if (units.size || noteSteps.length) {
    const tr = editor.state.tr
    let note = 0
    for (let i = 0; i <= items.length; i++) {
      while (note < noteSteps.length && noteSteps[note]!.afterBody === i) {
        tr.step(noteSteps[note++]!.step)
        finishTranslationUnit(tr)
      }
      const apply = items[i] && units.get(items[i]!)
      if (apply) {
        apply(tr)
        finishTranslationUnit(tr)
      }
    }
    if (track) tr.setMeta(TRACK_IGNORE, true)
    editor.view.dispatch(tr)
  }
  for (const report of reports) {
    if (report.empty || report.box !== undefined || report.nestedTable !== undefined) continue
    const fp = currentFingerprint(editor.state.doc, report.index, report.paragraph ?? 0)
    if (fp) report.fp = fp
  }
  return { ok: true, reports, stale, skippedBoxes }
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
  afterBody?: number
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
  | { ok: true; reports: NoteTranslationReport[]; units: NoteUnit[] }
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
  const units: NoteUnit[] = []
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
    const richParas = rich ? current.richParas!.slice() : null
    if (richParas) richParas[paragraph] = richParas[paragraph]!.map((r) => ({ ...r }))
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
    if (report.changed)
      units.push({
        kind: item.note,
        id: item.id,
        index: paragraph,
        afterBody: item.afterBody ?? 0,
        before: noteParagraph(current, paragraph, !!current.richParas && !next.richParas),
        after: noteParagraph(next, paragraph),
      })
    report.fp = runFingerprint(
      noteGroupsOf(next)
        .paragraphs.find((p) => p.paragraph === paragraph)!
        .groups.map((g) => g.text),
    )
    reports.push(report)
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, reports, units }
}

// ---------------------------------------------------------------------------
// Completion check
// ---------------------------------------------------------------------------

type HandledUnit = {
  index?: number
  paragraph?: number
  box?: number
  nestedTable?: number
  note?: NoteKind
  id?: string
  fp?: string
  incomplete?: unknown
}
const handledUnits = new WeakMap<object, Map<string, string>>()
function unitKey(unit: HandledUnit): string {
  return JSON.stringify([
    unit.note ?? 'body',
    unit.id ?? unit.index,
    unit.nestedTable,
    unit.box,
    unit.paragraph ?? 0,
  ])
}
/** Only the fingerprint of the applied result at this address is complete.
 * Repeated source strings in other cells and a paragraph restored by Undo
 * must still be eligible when the source and target share a script. */
export function recordHandled(editor: Editor, units: HandledUnit[]): void {
  let handled = handledUnits.get(originalAiEditor(editor))
  if (!handled) handledUnits.set(originalAiEditor(editor), (handled = new Map()))
  for (const unit of units) {
    if (unit.fp && !unit.incomplete) handled.set(unitKey(unit), unit.fp)
  }
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
  /** Fingerprints successfully handled out of all text-bearing translation units, independent of language heuristics. */
  progress: { done: number; total: number }
  /** body blocks (top-level index, plus the cell paragraph number in a table) still untranslated */
  body: string[]
  /** note paragraphs still untranslated, "footnote 3" / "endnote 2 paragraph 1" */
  notes: string[]
}

/**
 * The current result of a completed edit takes precedence over the script
 * heuristic: a translation may legitimately use the same script. For other
 * paragraphs and notes, check the source script or, if unknown, any letters.
 */
export function remainingUntranslated(
  editor: Editor,
  access: AiNotesAccess | undefined,
  language?: string,
  /** `tracking`: revision tracking is on, so text box paragraphs (which cannot carry revisions) are not counted */
  options: { tracking?: boolean; notesOnly?: boolean } = {},
): RemainingReport {
  const script = sourceScriptOf(language)
  const handled = handledUnits.get(originalAiEditor(editor))
  const progress = { done: 0, total: 0 }
  const pending = (segments: string[], fp: string, unit: HandledUnit): boolean => {
    if (handled?.get(unitKey(unit)) === fp) {
      progress.done++
      progress.total++
      return false
    }
    const text = segments.join(' ')
    const hasLetters = /\p{L}/u.test(text)
    if (hasLetters) progress.total++
    return script ? script.test(text) : hasLetters
  }
  const body: string[] = []
  const doc = editor.state.doc
  for (const entry of options.notesOnly
    ? []
    : readRunGroups(editor, 0, doc.childCount - 1, { compact: true })) {
    // The two bilingual sides form one handled source unit.
    if (entry.skip === TWIN_SKIP.source) {
      progress.done++
      progress.total++
      continue
    }
    if (!entry.segments || !entry.fp) continue
    if (options.tracking && entry.box !== undefined) continue
    if (pending(entry.segments, entry.fp, entry))
      body.push(
        entry.box !== undefined
          ? `${entry.index} (box ${entry.box} paragraph ${entry.paragraph})`
          : entry.nestedTable !== undefined
            ? `${entry.index} (nested table ${entry.nestedTable} paragraph ${entry.paragraph})`
            : entry.paragraph === undefined
              ? `${entry.index}`
              : `${entry.index} (paragraph ${entry.paragraph})`,
      )
  }
  const notes: string[] = []
  if (access) {
    for (const entry of readNoteRuns(access)) {
      if (pending(entry.segments, entry.fp, entry))
        notes.push(
          `${entry.note} ${entry.id}${entry.paragraph === undefined ? '' : ` paragraph ${entry.paragraph}`}`,
        )
    }
  }
  return { body, notes, progress }
}
