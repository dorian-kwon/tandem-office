import { patchTextboxParas } from '@genoffice/docx-engine'
import type { TextboxDisplay, TextboxParaPatch } from '@genoffice/docx-engine'

/**
 * Text boxes inside table cells. The editor shows them but does not edit them, and each box's
 * `txbxIndex` counts text segments inside its own paragraph only, so two cells both say 0. To
 * write a translated box back into the table's original bytes the box needs its number among the
 * text segments of the whole table, which is what `patchTextboxParas` addresses.
 *
 * That number is found by asking the engine itself: patch segment k with a marker and see which
 * box's text disappeared. This follows the engine's own counting (fallback twins, empty segments)
 * instead of guessing it, and a box that cannot be matched stays without a number, so it is shown
 * but never translated or written.
 */

/** a cell box with the number of its text segment in the whole table; absent = cannot be written */
export type CellBox = TextboxDisplay & { tableSegment?: number }

/** the most text segments of one table that are probed */
const MAX_SEGMENTS = 64
const MARK = ''

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decode(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code =
        name[1]!.toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1))
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })
}

/** the contents of every `w:t` of a fragment, in order */
function textsOf(xml: string): string[] {
  return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => decode(m[1]!))
}

/** the texts that differ between two lists (common start and end removed), joined */
function removedBetween(before: string[], after: string[]): string {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let end = 0
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  )
    end++
  return before.slice(start, before.length - end).join('')
}

/** the table fragment with text segment `segment` replaced by a marker; null when there is none */
function probe(tableXml: string, segment: number): string | null {
  const byIndex: (TextboxParaPatch[] | null)[] = Array.from({ length: segment + 1 }, () => null)
  byIndex[segment] = [{ runs: [{ text: MARK }], align: null, numPr: null }]
  try {
    const out = patchTextboxParas(tableXml, { byIndex } as never)
    return out === tableXml ? null : out
  } catch {
    return null
  }
}

/**
 * The text segment number of each box in the whole table, for boxes given in document order with
 * their plain text (all runs of all paragraphs joined). A box with no text, or whose text no
 * segment holds, gets undefined. A segment that belongs to no listed box (an unlisted shape, a
 * nested table) is passed over, so the numbers still follow the engine's own counting.
 */
export function assignTableSegments(tableXml: string, boxTexts: string[]): (number | undefined)[] {
  const result: (number | undefined)[] = boxTexts.map(() => undefined)
  const wanted = boxTexts.map((text, i) => ({ text, i })).filter((entry) => entry.text !== '')
  if (wanted.length === 0) return result
  const before = textsOf(tableXml)
  let next = 0
  for (let segment = 0; segment < MAX_SEGMENTS && next < wanted.length; segment++) {
    const patched = probe(tableXml, segment)
    if (patched === null) break
    const removed = removedBetween(before, textsOf(patched))
    const { text, i } = wanted[next]!
    // the drawing and its fallback twin both carry the text; one carries it when there is no twin
    if (removed === text || removed === text + text) {
      result[i] = segment
      next++
    }
  }
  return result
}

/** the plain text of a box: every run of every paragraph, joined */
export function cellBoxText(box: TextboxDisplay): string {
  return box.paras.map((p) => p.runs.map((r) => r.text).join('')).join('')
}

/** minimal shape of the editor JSON nodes this module walks */
interface JsonNode {
  type?: string
  attrs?: Record<string, unknown> | null
  content?: JsonNode[]
}

/**
 * Give every writable box of a table node its `tableSegment`, from the table's original XML.
 * Works on the editor JSON before the editor is built; the boxes are copied, never mutated, so
 * the parsed document model that serves as the save baseline stays as it was.
 */
export function annotateCellBoxSegments(table: JsonNode, tableXml: string): void {
  const groups: JsonNode[] = []
  const walk = (node: JsonNode) => {
    if (node.type === 'docCellBoxes' && Array.isArray(node.attrs?.boxes)) groups.push(node)
    for (const child of node.content ?? []) walk(child)
  }
  walk(table)
  const writable = (box: CellBox) => box.txbxIndex !== undefined && !box.readOnly
  const listed: CellBox[] = []
  for (const group of groups)
    for (const box of group.attrs!.boxes as CellBox[]) if (writable(box)) listed.push(box)
  if (listed.length === 0) return
  const numbers = assignTableSegments(tableXml, listed.map(cellBoxText))
  let at = 0
  for (const group of groups) {
    group.attrs!.boxes = (group.attrs!.boxes as CellBox[]).map((box) => {
      if (!writable(box)) return box
      const segment = numbers[at++]
      return segment === undefined ? box : { ...box, tableSegment: segment }
    })
  }
}
