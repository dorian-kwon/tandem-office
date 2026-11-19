import { TranslateIpcError } from '../../shared/translate-api'
import type { OcrTable } from '../../shared/translate-ocr'
interface Node {
  kind: string
  start: number
  openEnd: number
  closeStart: number
  end: number
  children: Node[]
}
function invalid(message: string): never {
  throw new TranslateIpcError('INVALID_ARGUMENT', message)
}
function tablesIn(xml: string): Node[] {
  const stack: Node[] = []
  const tables: Node[] = []
  for (const m of xml.matchAll(/<(\/?)w:(tbl|tr|tc)\b[^>]*>/g)) {
    if (m[1]) {
      const node = stack.pop()
      if (!node || node.kind !== m[2]) invalid('unsupported table structure')
      node.closeStart = m.index!
      node.end = m.index! + m[0].length
    } else {
      const node: Node = {
        kind: m[2]!,
        start: m.index!,
        openEnd: m.index! + m[0].length,
        closeStart: m.index! + m[0].length,
        end: m.index! + m[0].length,
        children: [],
      }
      stack.at(-1)?.children.push(node)
      if (node.kind === 'tbl') tables.push(node)
      if (!m[0].endsWith('/>')) stack.push(node)
    }
  }
  if (stack.length) invalid('unclosed table structure')
  return tables
}
function cellsOf(xml: string, row: Node) {
  const before = xml.slice(row.openEnd, row.children[0]?.start ?? row.closeStart)
  let column = Number(before.match(/<w:gridBefore\b[^>]*w:val=["'](\d+)["']/)?.[1] ?? 0) + 1
  return row.children
    .filter((n) => n.kind === 'tc')
    .map((node) => {
      const body = xml.slice(node.openEnd, node.closeStart)
      const properties = body.match(/^\s*<w:tcPr\b[^>]*(?:\/>|>[\s\S]*?<\/w:tcPr>)/)?.[0] ?? ''
      const span = Number(properties.match(/<w:gridSpan\b[^>]*w:val=["'](\d+)["']/)?.[1] ?? 1)
      if (!Number.isSafeInteger(span) || span < 1 || span > 16384 || !Number.isSafeInteger(column))
        invalid('unsupported merged cell')
      const start = column
      column += span
      const merge = properties.match(/<w:vMerge\b[^>]*>/)?.[0]
      return {
        node,
        body,
        properties,
        column: start,
        span,
        continuation: !!merge && !/w:val=["']restart["']/.test(merge),
      }
    })
}
function hasContent(body: string): boolean {
  return (
    body
      .replace(/<w:(tcPr|pPr|rPr)\b[^>]*(?:\/>|>[\s\S]*?<\/w:\1>)/g, '')
      .replace(/<\/?w:(?:p|r|t)\b[^>]*>/g, '')
      .trim().length > 0
  )
}

export function recommendWordCell(xml: string, locations: readonly string[]) {
  const tags = [...xml.matchAll(/<w:p\b[^>]*>/g)]
  const offsets = locations.map((location) => {
    const at = location.match(/^document\.xml · ¶(\d+)$/)
    return at && tags[Number(at[1]) - 1]?.index
  })
  const first = offsets[0]
  if (typeof first !== 'number') return null
  const tables = tablesIn(xml)
  // Tables are stored in document order. A nested picture is also inside every
  // enclosing cell, so only the innermost table may supply a neighbouring cell.
  let t = tables.length - 1
  while (t >= 0) {
    const table = tables[t]!
    if (first >= table.openEnd && first < table.closeStart) break
    t--
  }
  if (t < 0) return null
  const rows = tables[t]!.children.filter((n) => n.kind === 'tr')
  for (let r = 0; r < rows.length; r++) {
    const cells = cellsOf(xml, rows[r]!)
    const imageCell = cells.find((c) => first >= c.node.openEnd && first < c.node.closeStart)
    if (!imageCell) continue
    const next = cells.find(
      (c) =>
        c.column >= imageCell.column + imageCell.span && !c.continuation && !hasContent(c.body),
    )
    if (!next) return null
    const safe = offsets.every((offset, i) => {
      const row = rows[r + i]
      if (typeof offset !== 'number' || !row) return false
      const rowCells = i === 0 ? cells : cellsOf(xml, row)
      const source = rowCells.find(
        (cell) => offset >= cell.node.openEnd && offset < cell.node.closeStart,
      )
      if (!source || source.column + source.span > next.column) return false
      if (
        source.node.children.some(
          (child) => child.kind === 'tbl' && offset >= child.openEnd && offset < child.closeStart,
        )
      )
        return false
      const target = rowCells.find((cell) => cell.column === next.column)
      return target && !target.continuation && !hasContent(target.body)
    })
    if (safe)
      return {
        kind: 'docx-table-cell' as const,
        table: t + 1,
        row: r + 1,
        column: next.column,
        overwrite: false,
      }
    return null
  }
  return null
}
export function wordTables(xml: string): OcrTable[] {
  return tablesIn(xml).map((table, i) => {
    const rows = table.children.filter((n) => n.kind === 'tr')
    return {
      index: i + 1,
      rows: rows.length,
      columns: Math.max(
        0,
        ...rows.flatMap((row) => cellsOf(xml, row).map((c) => c.column + c.span - 1)),
      ),
    }
  })
}
export function placeInWordTable(
  xml: string,
  table: number,
  row: number,
  column: number,
  texts: string[],
  overwrite: boolean,
  paragraph: (text: string, pPr?: string, rPr?: string) => string,
): string {
  if (
    ![table, row, column].every((n) => Number.isSafeInteger(n) && n > 0) ||
    typeof overwrite !== 'boolean'
  )
    invalid('choose a valid table cell')
  const target = tablesIn(xml)[table - 1]
  if (!target) invalid('the chosen table does not exist')
  const rows = target!.children.filter((n) => n.kind === 'tr')
  const patches: { start: number; end: number; text: string }[] = []
  for (let i = 0; i < texts.length; i++) {
    const r = rows[row + i - 1]
    if (!r) invalid('the destination exceeds the table')
    const cell = cellsOf(xml, r!).find((c) => c.column === column)
    if (!cell || cell.continuation) invalid('choose the first cell of a merged range')
    if (/<w:(?:drawing|pict|object|tbl)\b/.test(cell.body))
      invalid('the chosen cell contains an image or nested table')
    if (hasContent(cell.body) && !overwrite)
      invalid('the cell has content; allow replacement or choose an empty cell')
    const pPr = cell.body.match(/<w:pPr\b[^>]*(?:\/>|>[\s\S]*?<\/w:pPr>)/)?.[0] ?? ''
    const rPr = cell.body.match(/<w:rPr\b[^>]*(?:\/>|>[\s\S]*?<\/w:rPr>)/)?.[0] ?? ''
    patches.push({
      start: cell.node.openEnd,
      end: cell.node.closeStart,
      text: cell.properties + paragraph(texts[i]!, pPr, rPr),
    })
  }
  for (const p of patches.sort((a, b) => b.start - a.start))
    xml = xml.slice(0, p.start) + p.text + xml.slice(p.end)
  return xml
}
