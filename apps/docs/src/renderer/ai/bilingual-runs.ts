import type { Editor } from '@tiptap/core'
import { Fragment, type Mark, type Node as PmNode, type Schema } from '@tiptap/pm/model'
import type { Transaction } from '@tiptap/pm/state'
import { TableMap } from '@tiptap/pm/tables'
import { TRACK_IGNORE } from '../editor/revisions'
import { PARA_FORMAT_ATTRS, paraFormatIsDefault } from '../editor/caret-marks'
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
  COPIED_CELL_ATTRS,
  columnWidthsPx,
  copyCellFormatting,
  insertColumnAt,
  insertRowAt,
  pctOf,
  reflowColumns,
} from './table-ops'
import {
  STARTS_WITH_CLOSING,
  edgesOf,
  fitParsed,
  gapsOf,
  blocksShifted,
  groupsOf,
  noteBlocksShifted,
  plainTwinRole,
  recordTwins,
  revisionDate,
  runFingerprint,
  segmentsError,
  settleTexts,
  tableTwinRoles,
  textblocksOf,
  topLevel,
  type Group,
  type RunTranslationItem,
} from './translate-runs'

/**
 * Bilingual output (add_bilingual): the original text stays and its translation
 * is added next to it. Same input convention as translate_blocks (read_runs
 * `fp` plus one translated string per segment), but nothing is replaced.
 *
 *  - A body paragraph, heading or list item: a new paragraph right after it
 *    ("after"), with the same paragraph formatting and the same run marks per
 *    segment. Only text is copied: footnote references, pictures, breaks and
 *    field results stay with the original; a tab stays a tab. A list item's
 *    twin is a plain paragraph at the item's text indent (a twin list item
 *    would take a number of its own).
 *  - A table: the whole table in one call. "right" inserts a new column right
 *    of every column that holds text, "below" a new row below every row that
 *    holds text. The new cells copy the neighbouring cell's formatting
 *    (copyCellFormatting) and take the original cell's paragraphs as twins. A
 *    table with merged cells (or an irregular grid) cannot take a column, so
 *    it falls back to "below", and a "below" there duplicates each group of
 *    rows tied together by vertical merges as a block right after the group,
 *    cell spans mirrored, so the grid stays valid. The fallback is reported.
 *
 * The originals are never edited. Each pair is remembered (recordTwins) so
 * read_runs lists both sides as skipped, the completion check never flags
 * either, and a second call for an original that already has a twin adds
 * nothing.
 */

export type BilingualLayout = 'after' | 'right' | 'below'

/**
 * An explicit destination for one item's translation.
 *  - cell: an existing table cell of block `index`, at `row` and `column` of the table's visual
 *    grid (both 0-based, as read_runs "cell":"r<row>c<column>" lists them; a merged cell is
 *    addressed by its top-left anchor). It must be empty, or `overwrite` with the destination's
 *    own `fp` (its single text paragraph, from read_runs) replaces its text.
 *  - after / before: a new paragraph right after / before ANY top-level block `index`.
 *  - end: a new paragraph at the end of the document.
 */
export type BilingualTarget =
  | { kind: 'cell'; index: number; row: number; column: number; overwrite?: boolean; fp?: string }
  | { kind: 'after'; index: number }
  | { kind: 'before'; index: number }
  | { kind: 'end' }

export interface BilingualItem extends RunTranslationItem {
  /** the fp is required here: a paragraph is never located by position alone */
  fp: string
  /** where the translation goes, instead of the call's layout */
  target?: BilingualTarget
}

/** one translation written at an explicit target */
export interface BilingualPlacedReport {
  index: number
  paragraph?: number
  /** where it went, in words */
  at: string
  extra?: number
}

export interface BilingualPlainReport {
  index: number
  incomplete?: { groups: number; given: number }
  extra?: number
}

export interface BilingualTableReport {
  index: number
  layout: 'right' | 'below'
  /** the layout asked for, when it could not be kept */
  requested?: 'right'
  /** why the table fell back to "below" */
  fellBack?: string
  /** merged cells: each group of rows tied by merges was repeated as a block below the group */
  blockwise?: string
  /** cell paragraphs given a twin */
  paragraphs: number
  extra: string[]
}

export type BilingualOutcome =
  | {
      ok: true
      /** body paragraphs added after their original */
      added: BilingualPlainReport[]
      tables: BilingualTableReport[]
      /** translations written at an explicit target */
      placed: BilingualPlacedReport[]
      /** items skipped because their paragraph (or destination) changed since read_runs; the rest was applied */
      stale: string[]
      /** items left alone because the original already has its twin */
      alreadyDone: string[]
      /** fingerprints of the originals and of their twins (completion tracking) */
      handled: string[]
      /** body paragraphs inserted by this call: every later block index moved down by up to this many */
      lastShift: number
    }
  | { ok: false; errors: string[] }

/** the marks a twin never takes over from the original text */
const DROPPED_MARKS = new Set(['comment', 'ins', 'del', 'revisionOriginal', 'rprChange'])

/** body paragraphs added so far per editor: the most block indexes can have shifted since a read */
const addedBodyTwins = new WeakMap<object, number>()

interface Piece {
  text: string
  marks: readonly Mark[]
  /** italic spans (offsets in `text`) added on top of `marks` */
  italics?: SpanOffsets
}

function twinMarks(marks: readonly Mark[], schema: Schema, track?: AiTrack, date?: string): Mark[] {
  const kept = marks
    .filter((m) => !DROPPED_MARKS.has(m.type.name))
    .map((m) =>
      m.type.name === 'docTextStyle' &&
      typeof m.attrs.rawRPr === 'string' &&
      m.attrs.rawRPr.includes('rPrChange')
        ? m.type.create({ ...m.attrs, rawRPr: null })
        : m,
    )
  if (!track) return kept
  return schema.marks.ins.create({ author: track.author, date }).addToSet(kept) as Mark[]
}

/** the translated text as marked pieces: groups joined by the separator the original had between them */
function composePieces(
  block: PmNode,
  pos: number,
  groups: Group[],
  settled: string[],
  spans: SpanOffsets[] = [],
): Piece[] {
  const pieces: Piece[] = []
  groups.forEach((group, i) => {
    if (settled[i] !== '')
      pieces.push({
        text: settled[i],
        marks: group.marks,
        ...(spans[i]?.length ? { italics: spans[i] } : {}),
      })
    const next = groups[i + 1]
    if (!next) return
    const between = block.textBetween(group.to - pos - 1, next.from - pos - 1, '', '￼')
    const tabs = (between.match(/\t/g) ?? []).length
    let sep = tabs > 0 ? '\t'.repeat(tabs) : between !== '' ? ' ' : ''
    if (sep === '') return
    const before = pieces.length > 0 ? pieces[pieces.length - 1].text : ''
    const after = settled[i + 1]
    if (sep === ' ' && (/\s$/.test(before) || /^\s/.test(after) || STARTS_WITH_CLOSING.test(after)))
      sep = ''
    if (sep !== '') pieces.push({ text: sep, marks: group.marks })
  })
  const live = pieces.filter((p) => p.text !== '')
  if (live.length > 0) {
    // a span starts and ends on a visible character, so trimming only shifts it
    const trimmed = (p: Piece, text: string, shift: number): Piece => {
      const { italics: _italics, ...rest } = p
      const italics = p.italics ? sliceSpans(p.italics, shift, shift + text.length) : []
      return { ...rest, text, ...(italics.length > 0 ? { italics } : {}) }
    }
    const first = live[0]
    const lead = /^\s*/.exec(first.text)![0].length
    live[0] = trimmed(first, first.text.slice(lead), lead)
    const last = live.length - 1
    const tail = live[last]
    const body = tail.text.replace(/\s+$/, '')
    live[last] = trimmed(tail, body, 0)
  }
  return live.filter((p) => p.text !== '')
}

/** the twin of a text block: its paragraph formatting, the given inline content, no identity */
function twinNode(
  schema: Schema,
  source: PmNode,
  pieces: Piece[],
  track?: AiTrack,
  date?: string,
): PmNode {
  const attrs: Record<string, unknown> = {}
  for (const key of PARA_FORMAT_ATTRS) if (key in source.attrs) attrs[key] = source.attrs[key]
  attrs.aiChanged = !track
  const kind = source.type.name
  if (kind === 'docHeading') {
    attrs.level = source.attrs.level
    attrs.outlineOnly = source.attrs.outlineOnly
  } else if (kind === 'docListItem') {
    attrs.indentLeft =
      source.attrs.indentLeft ?? 792 + 432 * Math.min(Number(source.attrs.ilvl) || 0, 4)
    attrs.indentFirstLine = null
    attrs.indentFirstLineChars = null
  }
  const type = kind === 'docHeading' ? schema.nodes.docHeading : schema.nodes.docParagraph
  const content = pieces.flatMap((p) =>
    textNodes(schema, p.text, twinMarks(p.marks, schema, track, date), p.italics),
  )
  return type.create(attrs, Fragment.fromArray(content))
}

interface Prepared {
  node: PmNode
  /** fingerprint of the original paragraph (as read_runs gave it) */
  fp: string
  /** fingerprint of the twin as read_runs would report it */
  twinFp: string
  incomplete?: { groups: number; given: number }
  extra?: number
}

type PrepareResult = { ok: true; prepared: Prepared } | { ok: false; error: string; stale?: true }

function prepare(
  schema: Schema,
  block: { node: PmNode; pos: number },
  item: BilingualItem,
  where: string,
  track?: AiTrack,
  date?: string,
): PrepareResult {
  const bad = segmentsError(where, item.segments)
  if (bad) return { ok: false, error: bad }
  const groups = groupsOf(block.node, block.pos)
  if (groups.length === 0)
    return { ok: false, error: `${where}: the paragraph has no text to translate` }
  const fp = runFingerprint(groups.map((g) => g.text))
  if (item.fp !== fp)
    return {
      ok: false,
      stale: true,
      error: `${where} changed since read_runs (fingerprint mismatch); read it again`,
    }
  // italic spans ride along as ranges; everything below works on the plain text
  const parsed = (item.segments as string[]).map(parseItalicSegment)
  if (parsed.length > 0 && parsed.every((p) => p.plain.trim() === ''))
    return { ok: false, error: `${where}: every segment is empty; give the translation` }
  const report: { extra?: number; incomplete?: { groups: number; given: number } } = {}
  const fitted = fitParsed(groups.length, parsed, report)
  const segments = fitted.map((p) => p.plain)
  if (report.incomplete)
    return {
      ok: false,
      error: `${where}: ${report.incomplete.given} of ${report.incomplete.groups} segments; a bilingual translation needs every segment (an empty string only for a piece with no counterpart)`,
    }
  const settled = settleTexts(
    groups.map((g) => g.text),
    segments,
    gapsOf(groups),
    edgesOf(groups),
  )
  const pieces = composePieces(
    block.node,
    block.pos,
    groups,
    settled,
    settled.map((text, i) => placeSpans(text, fitted[i])),
  )
  if (pieces.length === 0)
    return { ok: false, error: `${where}: the translation is empty; give the translation` }
  const node = twinNode(schema, block.node, pieces, track, date)
  const twinFp = runFingerprint(groupsOf(node, 0).map((g) => g.text))
  return {
    ok: true,
    prepared: { node, fp, twinFp, ...(report.extra ? { extra: report.extra } : {}) },
  }
}

function emptyTwin(schema: Schema, source: PmNode, track?: AiTrack): PmNode {
  return twinNode(schema, source, [], track)
}

/** does the item still point at its paragraph at `index` (not a twin)? */
function matches(editor: Editor, doc: PmNode, index: number, item: BilingualItem): boolean {
  const top = topLevel(doc, index)
  if (!top) return false
  const blocks = textblocksOf(top.node, top.pos)
  const block = blocks?.[item.paragraph ?? 0]
  if (!block) return false
  const groups = groupsOf(block.node, block.pos)
  if (groups.length === 0) return false
  const fp = runFingerprint(groups.map((g) => g.text))
  if (fp !== item.fp) return false
  return top.node.type.name === 'docTable' || plainTwinRole(editor, doc, index, fp) !== 'twin'
}

/**
 * The block index an item refers to. Added paragraphs shift every later index,
 * so a model that split its work over several calls from one read still points
 * at the old index; the fingerprint finds the paragraph again a few blocks down
 * (at most as far as paragraphs were added in this editor).
 */
function locate(editor: Editor, doc: PmNode, item: BilingualItem): number {
  if (matches(editor, doc, item.index, item)) return item.index
  const slack = addedBodyTwins.get(editor) ?? 0
  for (let d = 1; d <= slack; d++)
    if (matches(editor, doc, item.index + d, item)) return item.index + d
  return item.index
}

const label = (index: number, paragraph?: number): string =>
  paragraph === undefined ? `block ${index}` : `block ${index} paragraph ${paragraph}`

interface BodyOp {
  kind: 'body'
  /** position right after the original */
  at: number
  node: PmNode
  report: BilingualPlainReport
}

interface TableOp {
  kind: 'table'
  pos: number
  table: PmNode
  layout: 'right' | 'below'
  fellBack?: string
  /** paragraph number -> prepared twin */
  prepared: Map<number, Prepared>
  /** absolute start of each cell paragraph -> its paragraph number */
  numberAt: Map<number, number>
}

/** why a column cannot be inserted into this table without breaking the grid (null: it can) */
function gridProblem(table: PmNode, map: TableMap): string | null {
  if (map.problems && map.problems.length > 0) return 'its grid is irregular'
  let merged = false
  let cells = 0
  const seen = new Set<number>()
  for (const pos of map.map) {
    if (seen.has(pos)) continue
    seen.add(pos)
    cells++
    const attrs = table.nodeAt(pos)!.attrs
    if (Number(attrs.colspan) > 1 || Number(attrs.rowspan) > 1 || attrs.gridGap) merged = true
  }
  if (merged) return 'it has merged cells'
  if (cells !== map.width * map.height) return 'its grid is irregular'
  return null
}

/** the content of a new cell: a twin of every text paragraph of the original cell */
function twinCellContent(schema: Schema, op: TableOp, relCell: number, track?: AiTrack): PmNode[] {
  const cell = op.table.nodeAt(relCell)!
  const out: PmNode[] = []
  cell.forEach((child, offset) => {
    if (!child.isTextblock) return
    const abs = op.pos + 1 + relCell + 1 + offset
    const number = op.numberAt.get(abs)
    const prepared = number === undefined ? undefined : op.prepared.get(number)
    out.push(prepared ? prepared.node : emptyTwin(schema, child, track))
  })
  if (out.length === 0) out.push(schema.nodes.docParagraph.createAndFill()!)
  return out
}

/** the cells that hold a translatable paragraph, as grid positions */
function textCells(table: PmNode, map: TableMap, op: TableOp): Array<{ row: number; col: number }> {
  const out: Array<{ row: number; col: number }> = []
  const seen = new Set<number>()
  for (const rel of map.map) {
    if (seen.has(rel)) continue
    seen.add(rel)
    const cell = table.nodeAt(rel)!
    let has = false
    cell.forEach((child, offset) => {
      const n = op.numberAt.get(op.pos + 1 + rel + 1 + offset)
      if (n !== undefined && op.prepared.has(n)) has = true
    })
    if (has) {
      const rect = map.findCell(rel)
      out.push({ row: rect.top, col: rect.left })
    }
  }
  return out
}

function applyRight(tr: Transaction, op: TableOp, schema: Schema, track?: AiTrack, date?: string) {
  const map = TableMap.get(op.table)
  const cols = [...new Set(textCells(op.table, map, op).map((c) => c.col))].sort((a, b) => a - b)
  const widths = columnWidthsPx(op.table, map)
  const pct = pctOf(op.table, map, widths)
  for (let k = cols.length - 1; k >= 0; k--) insertColumnAt(tr, op.pos, cols[k] + 1)
  const twinCols = new Set(cols.map((c, k) => c + 1 + k))
  copyCellFormatting(
    tr,
    op.pos,
    (rect) => twinCols.has(rect.left),
    (rect) => [rect.top, rect.left - 1],
  )
  // the twin column takes half of its original column, so the table keeps its width
  const nextWidths: number[] | null = widths ? [] : null
  const nextPct: number[] = []
  for (let c = 0; c < map.width; c++) {
    if (cols.includes(c)) {
      if (widths && nextWidths) {
        const left = Math.round(widths[c] / 2)
        nextWidths.push(left, widths[c] - left)
      }
      nextPct.push(pct[c] / 2, pct[c] / 2)
    } else {
      if (widths && nextWidths) nextWidths.push(widths[c])
      nextPct.push(pct[c])
    }
  }
  reflowColumns(tr, op.pos, nextWidths, nextPct)
  const table = tr.doc.nodeAt(op.pos)!
  const fresh = TableMap.get(table)
  const fills: Array<{ pos: number; content: PmNode[] }> = []
  for (let row = 0; row < map.height; row++) {
    cols.forEach((col, k) => {
      const target = fresh.map[row * fresh.width + col + 1 + k]
      fills.push({
        pos: target,
        content: twinCellContent(schema, op, map.map[row * map.width + col], track),
      })
    })
  }
  fillCells(tr, op.pos, fills, track, date)
}

function applyBelow(tr: Transaction, op: TableOp, schema: Schema, track?: AiTrack, date?: string) {
  const map = TableMap.get(op.table)
  const rows = [...new Set(textCells(op.table, map, op).map((c) => c.row))].sort((a, b) => a - b)
  for (let k = rows.length - 1; k >= 0; k--) insertRowAt(tr, op.pos, rows[k] + 1)
  const twinRows = new Set(rows.map((r, k) => r + 1 + k))
  copyCellFormatting(
    tr,
    op.pos,
    (rect) => twinRows.has(rect.top),
    (rect) => [rect.top - 1, rect.left],
  )
  const table = tr.doc.nodeAt(op.pos)!
  const fresh = TableMap.get(table)
  const fills: Array<{ pos: number; content: PmNode[] }> = []
  rows.forEach((row, k) => {
    for (let col = 0; col < map.width; col++) {
      fills.push({
        pos: fresh.map[(row + 1 + k) * fresh.width + col],
        content: twinCellContent(schema, op, map.map[row * map.width + col], track),
      })
    }
  })
  if (track) {
    let offset = op.pos + 1
    table.forEach((rowNode, _o, index) => {
      if (twinRows.has(index))
        tr.setNodeMarkup(offset, undefined, {
          ...rowNode.attrs,
          rowRevision: { kind: 'ins', author: track.author, date },
        })
      offset += rowNode.nodeSize
    })
  }
  fillCells(tr, op.pos, fills, track, date)
}

/** replace the content of the given cells (positions inside the table content), last cell first */
function fillCells(
  tr: Transaction,
  tablePos: number,
  fills: Array<{ pos: number; content: PmNode[] }>,
  track?: AiTrack,
  date?: string,
): void {
  const start = tablePos + 1
  for (const fill of [...fills].sort((a, b) => b.pos - a.pos)) {
    const abs = start + fill.pos
    const cell = tr.doc.nodeAt(abs)!
    tr.replaceWith(abs + 1, abs + cell.nodeSize - 1, fill.content)
    if (track)
      tr.setNodeMarkup(abs, undefined, {
        ...cell.attrs,
        cellRevision: { kind: 'ins', author: track.author, date },
      })
  }
}

/** the groups of rows tied together by vertical merges: [first, last] row of each */
function rowBlocks(map: TableMap): Array<[number, number]> {
  const startsIn = (row: number): number[] => {
    const out: number[] = []
    const seen = new Set<number>()
    for (let c = 0; c < map.width; c++) {
      const pos = map.map[row * map.width + c]
      if (seen.has(pos)) continue
      seen.add(pos)
      if (map.findCell(pos).top === row) out.push(pos)
    }
    return out
  }
  const blocks: Array<[number, number]> = []
  let first = 0
  while (first < map.height) {
    let last = first
    for (let r = first; r <= last; r++)
      for (const pos of startsIn(r)) last = Math.max(last, map.findCell(pos).bottom - 1)
    blocks.push([first, last])
    first = last + 1
  }
  return blocks
}

/** a table with merged cells: each row block that holds text is repeated right after itself, spans mirrored */
function applyBlocksBelow(
  tr: Transaction,
  op: TableOp,
  schema: Schema,
  track?: AiTrack,
  date?: string,
): void {
  const { table } = op
  const map = TableMap.get(table)
  const textRows = new Set(textCells(table, map, op).map((c) => c.row))
  const rowStart: number[] = []
  let at = 0
  table.forEach((row) => {
    rowStart.push(at)
    at += row.nodeSize
  })
  const blocks = rowBlocks(map).filter(([a, b]) => {
    for (let r = a; r <= b; r++) if (textRows.has(r)) return true
    return false
  })
  const cellAttrOf = (cell: PmNode): Record<string, unknown> => {
    const attrs: Record<string, unknown> = {
      colspan: cell.attrs.colspan,
      rowspan: cell.attrs.rowspan,
      colwidth: cell.attrs.colwidth,
      gridGap: cell.attrs.gridGap,
      tcPrEdited: true,
    }
    for (const k of COPIED_CELL_ATTRS) attrs[k] = cell.attrs[k]
    return attrs
  }
  for (let b = blocks.length - 1; b >= 0; b--) {
    const [first, last] = blocks[b]
    const rows: PmNode[] = []
    for (let r = first; r <= last; r++) {
      const original = table.child(r)
      const cells: PmNode[] = []
      original.forEach((cell, offset) => {
        const rel = rowStart[r] + 1 + offset
        const attrs = cellAttrOf(cell)
        if (track) attrs.cellRevision = { kind: 'ins', author: track.author, date }
        cells.push(cell.type.create(attrs, twinCellContent(schema, op, rel, track)))
      })
      rows.push(
        original.type.create(
          {
            heightTwips: original.attrs.heightTwips,
            heightRule: original.attrs.heightRule,
            ...(track ? { rowRevision: { kind: 'ins', author: track.author, date } } : {}),
          },
          cells,
        ),
      )
    }
    tr.insert(op.pos + 1 + rowStart[last] + table.child(last).nodeSize, rows)
  }
}

interface PlaceOp {
  kind: 'place'
  at: number
  node: PmNode
  seq: number
}

interface CellOp {
  kind: 'cell'
  /** absolute position of the destination cell */
  at: number
  cell: PmNode
  content: PmNode[]
}

interface CellEntry {
  item: BilingualItem
  where: string
  prepared: Prepared
  /** absolute position of the original paragraph */
  originalPos: number
}

interface CellDestination {
  target: Extract<BilingualTarget, { kind: 'cell' }>
  entries: CellEntry[]
}

const preview = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 40 ? `${flat.slice(0, 40)}…` : flat
}

/** the destination paragraph's own formatting laid over the twin's (the original's) when it has any */
function withDestinationFormat(node: PmNode, destination: PmNode | undefined): PmNode {
  if (!destination || paraFormatIsDefault(destination)) return node
  const attrs = { ...node.attrs }
  for (const key of PARA_FORMAT_ATTRS) {
    const spec = destination.type.spec.attrs?.[key]
    if (key in destination.attrs && spec && destination.attrs[key] !== spec.default)
      attrs[key] = destination.attrs[key]
  }
  return node.type.create(attrs, node.content, node.marks)
}

type CellPlan =
  | { ok: true; op: CellOp; reports: BilingualPlacedReport[] }
  | { ok: false; error: string; stale?: true }

/** check one destination cell and build its new content */
function planCell(
  editor: Editor,
  doc: PmNode,
  dest: CellDestination,
  originals: ReadonlySet<number>,
  track?: AiTrack,
): CellPlan {
  const { target } = dest
  const at = `cell row ${target.row} column ${target.column} of block ${target.index}`
  const top = topLevel(doc, target.index)
  if (!top)
    return { ok: false, error: `${at}: no such block (the document has ${doc.childCount} blocks)` }
  if (top.node.type.name !== 'docTable')
    return {
      ok: false,
      error: `${at}: block ${target.index} is not a table; read_runs lists the table's block index (use target kind "after", "before" or "end" for a new paragraph)`,
    }
  if (isTrackedDeleted(top.node))
    return { ok: false, error: `${at}: the table is a pending tracked deletion; leave it alone` }
  const map = TableMap.get(top.node)
  const { row, column } = target
  if (!Number.isInteger(row) || !Number.isInteger(column) || row < 0 || column < 0)
    return { ok: false, error: `${at}: row and column are 0-based integers` }
  if (row >= map.height || column >= map.width)
    return {
      ok: false,
      error: `${at}: out of range (the table has ${map.height} rows and ${map.width} columns, 0-based); use the "cell" coordinates read_runs lists`,
    }
  const rel = map.map[row * map.width + column]
  const rect = map.findCell(rel)
  if (rect.top !== row || rect.left !== column)
    return {
      ok: false,
      error: `${at}: covered by a merged cell whose top-left anchor is row ${rect.top} column ${rect.left}; address it there (or pick another cell)`,
    }
  const cell = top.node.nodeAt(rel)!
  if (cell.attrs.gridGap)
    return { ok: false, error: `${at}: a grid gap cell cannot take text; pick another cell` }
  const cellPos = top.pos + 1 + rel
  for (const entry of dest.entries) {
    if (entry.originalPos >= cellPos && entry.originalPos < cellPos + cell.nodeSize)
      return {
        ok: false,
        error: `${entry.where}: the destination ${at} is the original itself; pick another cell`,
      }
  }
  const paragraphs: Array<{ node: PmNode; pos: number }> = []
  let onlyText = true
  cell.forEach((child, offset) => {
    if (child.isTextblock) paragraphs.push({ node: child, pos: cellPos + 1 + offset })
    else onlyText = false
  })
  for (const p of paragraphs)
    if (originals.has(p.pos))
      return { ok: false, error: `${at}: it holds the original of another item of this call` }
  const empty = onlyText && paragraphs.every((p) => p.node.childCount === 0)
  if (!empty) {
    const shown = preview(cell.textContent)
    if (!target.overwrite)
      return {
        ok: false,
        error: `${at}: not empty${shown ? ` (it holds "${shown}")` : ' (it holds a picture or another object)'}; pick an empty cell (read_runs marks them "empty":true), or pass overwrite:true with this cell's own "fp" from read_runs to replace its text`,
      }
    if (track)
      return {
        ok: false,
        error: `${at}: replacing existing text is not possible while changes are tracked (the old text could not be marked as deleted); pick an empty cell`,
      }
    const texty = paragraphs.filter((p) => groupsOf(p.node, p.pos).length > 0)
    if (!onlyText || texty.length !== 1)
      return {
        ok: false,
        error: `${at}: overwrite replaces a cell with exactly one text paragraph and nothing else; this one has ${onlyText ? `${texty.length} text paragraphs` : 'a nested table'}. Pick another cell`,
      }
    if (dest.entries.length > 1)
      return {
        ok: false,
        error: `${at}: overwrite takes one translation; ${dest.entries.length} were given for it`,
      }
    const destFp = runFingerprint(groupsOf(texty[0].node, texty[0].pos).map((g) => g.text))
    if (target.fp !== destFp)
      return {
        ok: false,
        ...(target.fp ? { stale: true as const } : {}),
        error: `${at}: overwrite needs the destination's own "fp" as target.fp (read_runs lists it for the cell's paragraph)${target.fp ? '; the given one no longer matches, read it again' : ''}`,
      }
    const blocks = textblocksOf(top.node, top.pos) ?? []
    const roles = tableTwinRoles(
      editor,
      blocks.map((b) => {
        const g = groupsOf(b.node, b.pos)
        return g.length > 0 ? runFingerprint(g.map((x) => x.text)) : null
      }),
    )
    if (roles[blocks.findIndex((b) => b.pos === texty[0].pos)] === 'source')
      return {
        ok: false,
        error: `${at}: it holds an original that already has a translation; pick another cell`,
      }
  }
  const content = dest.entries.map((entry, k) =>
    withDestinationFormat(
      entry.prepared.node,
      paragraphs[Math.min(k, paragraphs.length - 1)]?.node,
    ),
  )
  return {
    ok: true,
    op: { kind: 'cell', at: cellPos, cell, content },
    reports: dest.entries.map((entry) => ({
      index: entry.item.index,
      ...(entry.item.paragraph === undefined ? {} : { paragraph: entry.item.paragraph }),
      at: `${empty ? '' : 'over the text of '}${at}`,
      ...(entry.prepared.extra ? { extra: entry.prepared.extra } : {}),
    })),
  }
}

/**
 * add_bilingual: every item checked first, one bad item refuses the whole call
 * with nothing changed. All edits land in one transaction (one undo step).
 */
export function applyBilingual(
  editor: Editor,
  layout: BilingualLayout | undefined,
  items: BilingualItem[],
  track?: AiTrack,
): BilingualOutcome {
  const doc = editor.state.doc
  const schema = editor.schema
  const date = track ? revisionDate() : undefined
  const errors: string[] = []
  const stale: string[] = []
  const alreadyDone: string[] = []
  const seen = new Set<string>()
  const bodyOps: BodyOp[] = []
  const tableOps: TableOp[] = []
  const tableItems = new Map<number, Array<{ item: BilingualItem; index: number }>>()
  const pairs: Array<[string, string]> = []
  const tableReports: BilingualTableReport[] = []
  const placeOps: PlaceOp[] = []
  const placedReports: BilingualPlacedReport[] = []
  const cellDests = new Map<string, CellDestination>()
  const originals = new Set<number>()
  const placedPairsList: Array<[string, string]> = []
  let seq = 0

  for (const item of items) {
    const index = locate(editor, doc, item)
    const where = label(index, item.paragraph)
    const key = `${index}:${item.paragraph ?? 0}`
    if (seen.has(key)) {
      errors.push(`${where}: listed twice`)
      continue
    }
    seen.add(key)
    const top = topLevel(doc, index)
    if (!top) {
      stale.push(
        `${where}: no such block (the document has ${doc.childCount} blocks); read it again`,
      )
      continue
    }
    if (isTrackedDeleted(top.node)) {
      errors.push(`${where}: the block is a pending tracked deletion; leave it alone`)
      continue
    }
    const blocks = textblocksOf(top.node, top.pos)
    if (!blocks) {
      errors.push(`${where}: a ${top.node.type.name} block has no text to translate`)
      continue
    }
    if (item.target) {
      // explicit destination: the original is a body paragraph or one cell paragraph
      const target = item.target
      const isTable = top.node.type.name === 'docTable'
      if (isTable && !Number.isInteger(item.paragraph)) {
        errors.push(
          `${where}: a table block needs "paragraph" (the cell paragraph number read_runs lists)`,
        )
        continue
      }
      if (!isTable && item.paragraph !== undefined && item.paragraph !== 0) {
        errors.push(`${where}: no such paragraph (a body block has one)`)
        continue
      }
      const block = blocks[isTable ? (item.paragraph as number) : 0]
      if (!block) {
        errors.push(
          `${where}: no such paragraph (the block has ${blocks.length}); use the paragraph numbers read_runs lists`,
        )
        continue
      }
      const groups = groupsOf(block.node, block.pos)
      if (groups.length === 0) {
        errors.push(`${where}: the paragraph has no text to translate`)
        continue
      }
      const ownFp = runFingerprint(groups.map((g) => g.text))
      const role = isTable
        ? tableTwinRoles(
            editor,
            blocks.map((b) => {
              const g = groupsOf(b.node, b.pos)
              return g.length > 0 ? runFingerprint(g.map((x) => x.text)) : null
            }),
          )[item.paragraph as number]
        : plainTwinRole(editor, doc, index, ownFp)
      if (role === 'twin') {
        errors.push(`${where}: this is a translation add_bilingual already added; leave it alone`)
        continue
      }
      if (
        role === 'source' &&
        item.fp === ownFp &&
        /\p{L}/u.test(groups.map((g) => g.text).join(' '))
      ) {
        alreadyDone.push(where)
        continue
      }
      if (target.kind !== 'end' && blocksShifted(editor)) {
        errors.push(
          `${where}: block indexes moved since your last read_runs (translations were added); call read_runs again before choosing a destination`,
        )
        continue
      }
      const made = prepare(schema, block, item, where, track, date)
      if (!made.ok) {
        ;(made.stale ? stale : errors).push(made.error)
        continue
      }
      const { prepared } = made
      originals.add(block.pos)
      if (target.kind === 'cell') {
        const dkey = `${target.index}:${target.row}:${target.column}`
        const dest = cellDests.get(dkey) ?? { target, entries: [] }
        dest.entries.push({ item, where, prepared, originalPos: block.pos })
        cellDests.set(dkey, dest)
      } else if (target.kind === 'end') {
        placeOps.push({ kind: 'place', at: doc.content.size, node: prepared.node, seq: seq++ })
        placedReports.push({
          index,
          ...(item.paragraph === undefined ? {} : { paragraph: item.paragraph }),
          at: 'the end of the document',
          ...(prepared.extra ? { extra: prepared.extra } : {}),
        })
      } else {
        const anchor = topLevel(doc, target.index)
        if (!anchor) {
          errors.push(
            `${where}: target ${target.kind} block ${target.index}: no such block (the document has ${doc.childCount} blocks)`,
          )
          continue
        }
        placeOps.push({
          kind: 'place',
          at: target.kind === 'after' ? anchor.pos + anchor.node.nodeSize : anchor.pos,
          node: prepared.node,
          seq: seq++,
        })
        placedReports.push({
          index,
          ...(item.paragraph === undefined ? {} : { paragraph: item.paragraph }),
          at: `a new paragraph ${target.kind} block ${target.index}`,
          ...(prepared.extra ? { extra: prepared.extra } : {}),
        })
      }
      placedPairsList.push([prepared.fp, prepared.twinFp])
      continue
    }
    if (!layout) {
      errors.push(`${where}: give a "target" for this item or a layout for the call`)
      continue
    }
    if (top.node.type.name === 'docTable') {
      if (layout === 'after') {
        errors.push(`${where}: a table needs layout "right" or "below" (ask the person which)`)
        continue
      }
      if (!Number.isInteger(item.paragraph)) {
        errors.push(
          `${where}: a table block needs "paragraph" (the cell paragraph number read_runs lists)`,
        )
        continue
      }
      const list = tableItems.get(index) ?? []
      list.push({ item, index })
      tableItems.set(index, list)
      continue
    }
    if (item.paragraph !== undefined && item.paragraph !== 0) {
      errors.push(`${where}: no such paragraph (a body block has one)`)
      continue
    }
    const groups = groupsOf(top.node, top.pos)
    if (groups.length === 0) continue
    const role = plainTwinRole(editor, doc, index, runFingerprint(groups.map((g) => g.text)))
    if (role === 'twin') {
      errors.push(`${where}: this is a translation add_bilingual already added; leave it alone`)
      continue
    }
    if (role === 'source') {
      alreadyDone.push(where)
      continue
    }
    const made = prepare(schema, top, item, where, track, date)
    if (!made.ok) {
      ;(made.stale ? stale : errors).push(made.error)
      continue
    }
    const { prepared } = made
    pairs.push([prepared.fp, prepared.twinFp])
    bodyOps.push({
      kind: 'body',
      at: top.pos + top.node.nodeSize,
      node: prepared.node,
      report: {
        index,
        ...(prepared.extra ? { extra: prepared.extra } : {}),
      },
    })
  }

  for (const [index, list] of tableItems) {
    const top = topLevel(doc, index)!
    const blocks = textblocksOf(top.node, top.pos)!
    const fps = blocks.map((b) => {
      const g = groupsOf(b.node, b.pos)
      return g.length > 0 ? runFingerprint(g.map((x) => x.text)) : null
    })
    const roles = tableTwinRoles(editor, fps)
    if (roles.some((r) => r !== null)) {
      alreadyDone.push(`block ${index} (table)`)
      continue
    }
    // a paragraph without a letter (a number, a bullet) may stay out of the call
    const wanted = blocks.flatMap((b, n) =>
      fps[n] !== null &&
      /\p{L}/u.test(
        groupsOf(b.node, b.pos)
          .map((g) => g.text)
          .join(' '),
      )
        ? [n]
        : [],
    )
    const given = new Set(list.map((l) => l.item.paragraph as number))
    const missing = wanted.filter((n) => !given.has(n))
    if (missing.length > 0) {
      errors.push(
        `block ${index}: add_bilingual adds a whole table at once; also pass paragraph ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ` …(+${missing.length - 20})` : ''} of this table in the same call`,
      )
      continue
    }
    const prepared = new Map<number, Prepared>()
    const tableErrors: string[] = []
    const tableStale: string[] = []
    const extra: string[] = []
    for (const { item } of list) {
      const n = item.paragraph as number
      const block = blocks[n]
      const where = label(index, n)
      if (!block) {
        tableErrors.push(
          `${where}: no such paragraph (the block has ${blocks.length}); use the paragraph numbers read_runs lists`,
        )
        continue
      }
      if (fps[n] === null) continue
      const made = prepare(schema, block, item, where, track, date)
      if (!made.ok) (made.stale ? tableStale : tableErrors).push(made.error)
      else {
        prepared.set(n, made.prepared)
        if (made.prepared.extra) extra.push(`paragraph ${n} (+${made.prepared.extra})`)
      }
    }
    if (tableErrors.length > 0) {
      errors.push(...tableErrors)
      continue
    }
    if (tableStale.length > 0) {
      // a table's cells must all be current: the whole table is skipped
      stale.push(`${tableStale.join('; ')} (table block ${index} skipped whole)`)
      continue
    }
    const numberAt = new Map<number, number>()
    blocks.forEach((b, n) => numberAt.set(b.pos, n))
    const map = TableMap.get(top.node)
    const problem = gridProblem(top.node, map)
    const op: TableOp = {
      kind: 'table',
      pos: top.pos,
      table: top.node,
      layout: layout === 'right' && !problem ? 'right' : 'below',
      ...(problem ? { fellBack: problem } : {}),
      prepared,
      numberAt,
    }
    tableOps.push(op)
    for (const p of prepared.values()) pairs.push([p.fp, p.twinFp])
    tableReports.push({
      index,
      layout: op.layout,
      ...(layout === 'right' && problem ? { requested: 'right' as const, fellBack: problem } : {}),
      ...(problem ? { blockwise: problem } : {}),
      paragraphs: prepared.size,
      extra,
    })
  }

  const cellOps: CellOp[] = []
  for (const dest of cellDests.values()) {
    const plan = planCell(editor, doc, dest, originals, track)
    if (!plan.ok) {
      ;(plan.stale ? stale : errors).push(plan.error)
      continue
    }
    const tablePos = topLevel(doc, dest.target.index)!.pos
    if (tableOps.some((o) => o.pos === tablePos)) {
      errors.push(
        `block ${dest.target.index}: a table cannot take a layout translation and an explicit cell destination in the same call; split them`,
      )
      continue
    }
    cellOps.push(plan.op)
    placedReports.push(...plan.reports)
  }

  if (errors.length > 0) return { ok: false, errors }
  if (
    stale.length > 0 &&
    bodyOps.length + tableOps.length + placeOps.length + cellOps.length === 0 &&
    alreadyDone.length === 0
  )
    return { ok: false, errors: stale }

  const tr = editor.state.tr
  // last position first, so an edit never shifts the ones still ahead; a table starts where the
  // paragraph before it ends, and its own edits must run before that paragraph's insertion
  const opPos = (o: BodyOp | TableOp | PlaceOp | CellOp): number =>
    o.kind === 'table' ? o.pos : o.at
  const ops = [...bodyOps, ...tableOps, ...placeOps, ...cellOps].sort(
    (a, b) =>
      opPos(b) - opPos(a) ||
      (a.kind === 'table' || a.kind === 'cell' ? -1 : 1) -
        (b.kind === 'table' || b.kind === 'cell' ? -1 : 1) ||
      (b.kind === 'place' ? b.seq : 0) - (a.kind === 'place' ? a.seq : 0),
  )
  for (const op of ops) {
    if (op.kind === 'body' || op.kind === 'place') tr.insert(op.at, op.node)
    else if (op.kind === 'cell') tr.replaceWith(op.at + 1, op.at + op.cell.nodeSize - 1, op.content)
    else if (op.fellBack && op.layout === 'below') {
      // merged cells or an irregular grid: row blocks keep the grid valid
      applyBlocksBelow(tr, op, schema, track, date)
    } else if (op.layout === 'right') applyRight(tr, op, schema, track, date)
    else applyBelow(tr, op, schema, track, date)
  }
  if (track) tr.setMeta(TRACK_IGNORE, true)
  if (ops.length > 0) editor.view.dispatch(tr)
  if (pairs.length > 0) recordTwins(editor, pairs)
  if (placedPairsList.length > 0) recordTwins(editor, placedPairsList, { placed: true })
  const inserted = bodyOps.length + placeOps.length
  addedBodyTwins.set(editor, (addedBodyTwins.get(editor) ?? 0) + inserted)
  if (inserted > 0) noteBlocksShifted(editor)
  return {
    ok: true,
    added: bodyOps.map((o) => o.report),
    tables: tableReports,
    placed: placedReports,
    stale,
    alreadyDone,
    handled: [...pairs, ...placedPairsList].flat(),
    lastShift: inserted,
  }
}
