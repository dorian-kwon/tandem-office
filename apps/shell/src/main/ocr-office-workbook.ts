import { readFile, writeFile } from 'node:fs/promises'
import { posix } from 'node:path'
import {
  parseRels,
  resolveRelationshipTargetPath,
} from '../../../../packages/docx-engine/src/parse-package'
import { loadDocxZip } from '../../../../packages/docx-engine/src/zip-load'
import { writeWorkbook } from '../../../../packages/cli/src/formats/xlsx'
import type { OcrEngine, PdfiumModule } from '../../../../packages/pdf2docx/src'
import { recognizedPageGrid } from '../../../../packages/pdf2docx/src/rebuild-xlsx/rebuild'
import type { CellStyleSpec } from '../../../../packages/pdf2docx/src/rebuild-xlsx/workbook'
import { parseSheetElements, validateSheetName } from '@genoffice/xlsx-gateway/gateway/xlsx-sheets'
import {
  readBasicWorkbook,
  type CellEdit,
  type SheetStructuralOps,
} from '@genoffice/xlsx-gateway/gateway/xlsx-gateway'
import type {
  CellArea,
  StructuralOp,
} from '../../../../packages/xlsx-gateway/src/gateway/xlsx-structure'
import type {
  WorkbookVisualEdit,
  WorkbookStyleEdit,
} from '@genoffice/xlsx-gateway/shared/edit-schemas'
import { cellAddress, cellPosition } from './translate/ocr-xlsx-structure'
import { recognizedPicturePages } from './ocr-office-word'

export type ExcelOcrDestination =
  | { kind: 'xlsx-cells'; sheet: string; cell: string; overwrite: false }
  | { kind: 'xlsx-new-sheet'; sheet: string }

type WorkbookCells = Awaited<
  ReturnType<typeof readBasicWorkbook>
>['snapshot']['sheets'][number]['cells']
type Position = { row: number; column: number }
const origin = { row: 0, column: 0 }

function cellRange(ref: string, offset: Position = origin): CellArea | undefined {
  const [a, b] = ref.split(':')
  const start = cellPosition(a!)
  const end = cellPosition(b ?? a!)
  if (!start || !end) return
  return {
    startRow: start.row + offset.row,
    endRow: end.row + offset.row,
    startColumn: start.column + offset.column,
    endColumn: end.column + offset.column,
  }
}
const overlaps = (a: CellArea, b: CellArea) =>
  a.startRow <= b.endRow &&
  b.startRow <= a.endRow &&
  a.startColumn <= b.endColumn &&
  b.startColumn <= a.endColumn

function marker(xml: string, name: 'from' | 'to') {
  const body = new RegExp(
    '<(?:[\\w.-]+:)?' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?' + name + '>',
  ).exec(xml)?.[1]
  if (!body) return
  const r = /<(?:[\w.-]+:)?row>(\d+)<\//.exec(body)
  const c = /<(?:[\w.-]+:)?col>(\d+)<\//.exec(body)
  if (!r || !c) return
  const rowOff = Number(/<(?:[\w.-]+:)?rowOff>(-?\d+)<\//.exec(body)?.[1] ?? 0)
  const colOff = Number(/<(?:[\w.-]+:)?colOff>(-?\d+)<\//.exec(body)?.[1] ?? 0)
  return { row: Number(r[1]), column: Number(c[1]), rowOff, colOff }
}
/** Map a one-cell anchor's physical height (EMUs) to the first row below the picture.
 * Unspecified rows are skipped as a single span, even in sparse million-row sheets. */
function rowBelowPicture(sheetXml: string) {
  const format = /<(?:[\w.-]+:)?sheetFormatPr\b[^>]*>/.exec(sheetXml)?.[0] ?? ''
  const defaultHeight = /\szeroHeight=["'](?:true|1)["']/.test(format)
    ? 0
    : Number(/\sdefaultRowHeight=["']([\d.]+)["']/.exec(format)?.[1] ?? 15)
  const rows: { row: number; height: number }[] = []
  for (const m of sheetXml.matchAll(/<(?:[\w.-]+:)?row\b[^>]*>/g)) {
    const row = Number(/\sr=["'](\d+)["']/.exec(m[0])?.[1]) - 1
    const height = /\shidden=["'](?:true|1)["']/.test(m[0])
      ? 0
      : Number(/\sht=["']([\d.]+)["']/.exec(m[0])?.[1] ?? defaultHeight)
    if (Number.isInteger(row) && row >= 0 && height !== defaultHeight) rows.push({ row, height })
  }
  return (start: number, emu: number) => {
    if (!Number.isFinite(emu) || emu <= 0) return
    let remaining = emu / 12700,
      index = start
    for (const entry of rows) {
      if (entry.row < index) continue
      const ordinary = (entry.row - index) * defaultHeight
      if (defaultHeight > 0 && remaining <= ordinary)
        return index + Math.ceil(remaining / defaultHeight)
      remaining -= ordinary + entry.height
      index = entry.row + 1
      if (remaining <= 0) return index
    }
    return defaultHeight > 0 ? index + Math.ceil(remaining / defaultHeight) : undefined
  }
}

function anchors(xml: string, rowBelow: ReturnType<typeof rowBelowPicture>) {
  return Array.from(
    xml.matchAll(
      /<([\w.-]+:)?(twoCellAnchor|oneCellAnchor|absoluteAnchor)\b[\s\S]*?<\/(?:[\w.-]+:)?\2>/g,
    ),
    (match, index) => {
      const body = match[0]
      const from = marker(body, 'from')
      const to = marker(body, 'to')
      const height = Number(/<(?:[\w.-]+:)?ext\b[^>]*\scy=["'](\d+)["']/.exec(body)?.[1])
      const bottom = to
        ? to.row + (to.rowOff > 0 ? 1 : 0)
        : from
          ? rowBelow(from.row, height + from.rowOff)
          : undefined
      // A one-cell anchor has no terminal column. Conservatively reserve all columns after
      // its start on occupied rows when checking collisions with a different drawing.
      const area =
        from && bottom !== undefined
          ? {
              startRow: from.row,
              endRow: Math.max(from.row, bottom - 1),
              startColumn: from.column,
              endColumn: to ? Math.max(from.column, to.column - (to.colOff === 0 ? 1 : 0)) : 16_383,
            }
          : undefined
      const embeds = Array.from(
        body.matchAll(/<(?:[\w.-]+:)?blip\b[^>]*\sr:embed=(?:"([^"]+)"|'([^']+)')[^>]*>/g),
        (m) => m[1] ?? m[2]!,
      )
      // A group may own several pictures and shapes. Never remove its anchor for one member.
      const simple =
        embeds.length === 1 &&
        /<(?:[\w.-]+:)?pic\b/.test(body) &&
        !/<(?:[\w.-]+:)?(?:grpSp|graphicFrame|AlternateContent)\b/.test(body)
      return { from, area, bottom, embeds, index, simple }
    },
  )
}
const relsPart = (part: string) =>
  posix.join(posix.dirname(part), '_rels', posix.basename(part) + '.rels')
function newSheetName(sheet: string, anchor: Position | undefined, used: Set<string>): string {
  const base = sheet + ' OCR' + (anchor ? ' ' + cellAddress(anchor.row, anchor.column) : '')
  for (let i = 1; ; i++) {
    const suffix = i === 1 ? '' : ' (' + i + ')'
    const name =
      Array.from(base).reduce(
        (text, char) => (text.length + char.length <= 31 - suffix.length ? text + char : text),
        '',
      ) + suffix
    if (!used.has(name.toLowerCase())) {
      used.add(name.toLowerCase())
      return name
    }
  }
}

function outputCellStyle(
  spec: CellStyleSpec | undefined,
  keepFormStyle: boolean,
): WorkbookStyleEdit | undefined {
  if (!spec) return
  const style: WorkbookStyleEdit = {}
  if (spec.numFmt) style.numberFormat = spec.numFmt
  if (!keepFormStyle) {
    if (spec.align?.wrapText) style.wrapText = true
    if (spec.align?.vertical) style.verticalAlignment = spec.align.vertical
    if (spec.align?.horizontal) style.horizontalAlignment = spec.align.horizontal
    if (spec.font?.bold) style.bold = true
    if (spec.font?.italic) style.italic = true
    if (spec.fill) style.fillColor = '#' + spec.fill
    if (spec.font?.color) style.fontColor = '#' + spec.font.color
    if (spec.border?.top) style.borderTop = { style: 'thin', color: '#' + spec.border.top }
    if (spec.border?.bottom) style.borderBottom = { style: 'thin', color: '#' + spec.border.bottom }
    if (spec.border?.left) style.borderLeft = { style: 'thin', color: '#' + spec.border.left }
    if (spec.border?.right) style.borderRight = { style: 'thin', color: '#' + spec.border.right }
  }
  return Object.keys(style).length ? style : undefined
}

function worksheetSpace(xml: string, cells: WorkbookCells) {
  const blocked: CellArea[] = []
  for (const m of xml.matchAll(/<(?:[\w.-]+:)?mergeCell\b[^>]*\bref=["']([^"']+)["']/g)) {
    const range = cellRange(m[1]!)
    if (range) blocked.push(range)
  }
  const styledCells = new Set<string>()
  for (const cell of xml.matchAll(/<(?:[\w.-]+:)?c\b[^>]*>/g)) {
    if (!/\ss=["'][1-9]\d*["']/.test(cell[0])) continue
    const address = /\sr=["']([^"']+)["']/.exec(cell[0])?.[1]
    if (address) styledCells.add(address)
  }
  const occupied = Object.entries(cells).flatMap(([address, c]) => {
    if (!c.formula && (c.value === null || c.value === undefined || c.value === '')) return []
    const range = cellRange(address)
    return range ? [range] : []
  })
  const protectedSheet = /<(?:[\w.-]+:)?sheetProtection\b/.test(xml)
  return { blocked, styledCells, occupied, protectedSheet }
}

async function chosenDestination(
  choice: ExcelOcrDestination,
  bookXml: string,
  names: string[],
  readSheetSpace: (name: string) => Promise<ReturnType<typeof worksheetSpace>>,
) {
  validateSheetName(choice.sheet)
  if (choice.kind === 'xlsx-new-sheet') {
    if (names.some((n) => n.toLowerCase() === choice.sheet.toLowerCase()))
      throw Error('OCR_SHEET_NAME_USED')
    if (/<(?:[\w.-]+:)?workbookProtection\b[^>]*\blockStructure=["'](?:true|1)["']/.test(bookXml))
      throw Error('OCR_SHEET_PROTECTED')
    return { offset: { ...origin }, styledCells: new Set<string>(), blockers: [] as CellArea[] }
  }
  const offset = typeof choice.cell === 'string' && cellPosition(choice.cell)
  if (
    choice.kind !== 'xlsx-cells' ||
    choice.overwrite !== false ||
    !names.includes(choice.sheet) ||
    !offset
  )
    throw Error('OCR_SHEET_DESTINATION_INVALID')
  const space = await readSheetSpace(choice.sheet)
  if (space.protectedSheet) throw Error('OCR_SHEET_PROTECTED')
  const blockers = [...space.blocked, ...space.occupied]
  if (blockers.some((r) => overlaps(r, cellRange(choice.cell)!)))
    throw Error('OCR_SHEET_DESTINATION_OCCUPIED')
  return { offset, styledCells: space.styledCells, blockers }
}

/** Replace scans that can occupy blank cells in the workbook copy. A conflicting scan
 * keeps its drawing and gets a separate editable OCR sheet; no existing formula is displaced. */
export async function ocrOfficeWorkbook(
  input: string,
  output: string,
  pdfium: PdfiumModule,
  ocr: OcrEngine,
  placement: 'replace' | 'below' = 'replace',
  destination?: ExcelOcrDestination,
  plainText = false,
): Promise<void> {
  const source = await readFile(input)
  const zip = await loadDocxZip(source)
  const workbook = 'xl/workbook.xml'
  const bookXml = await zip.file(workbook)?.async('string')
  if (!bookXml) throw Error('Excel workbook is missing')
  const bookRels = await parseRels(zip, relsPart(workbook))
  const { snapshot } = await readBasicWorkbook(source)
  const names = snapshot.sheets.map((s) => s.name)
  const usedNames = new Set(names.map((s) => s.toLowerCase()))
  const newSheets: string[] = []
  const selected = destination
    ? await chosenDestination(destination, bookXml, names, async (name) => {
        const sheet = parseSheetElements(bookXml).find((s) => s.name === name)
        const relation = bookRels.get(sheet?.relationshipId ?? '')
        const path =
          relation &&
          relation.targetMode !== 'External' &&
          resolveRelationshipTargetPath(workbook, relation.target)
        const xml = path && (await zip.file(path)?.async('string'))
        const cells = snapshot.sheets.find((s) => s.name === name)?.cells
        if (!xml || !cells) throw Error('OCR_SHEET_DESTINATION_INVALID')
        return worksheetSpace(xml, cells)
      })
    : undefined
  if (destination?.kind === 'xlsx-new-sheet') newSheets.push(destination.sheet)
  const cached = new Map<string, ReturnType<typeof recognizedPageGrid> | null>()
  const edits: CellEdit[] = []
  const visuals: WorkbookVisualEdit[] = []
  const structure = new Map<string, StructuralOp[]>()
  const requestedColumnWidths = new Map<number, number>()
  let hasNativeText = false
  let hasScan = false
  for (const sheet of parseSheetElements(bookXml)) {
    const rel = bookRels.get(sheet.relationshipId ?? '')
    const part =
      rel && rel.targetMode !== 'External' && resolveRelationshipTargetPath(workbook, rel.target)
    const xml = part && (await zip.file(part)?.async('string'))
    const cells = snapshot.sheets.find((s) => s.name === sheet.name)?.cells
    if (!xml || !part || !cells) continue
    hasNativeText ||= Object.values(cells).some(
      (c) => c.formula || (c.value !== null && c.value !== undefined && c.value !== ''),
    )
    const { blocked, styledCells, occupied, protectedSheet } = worksheetSpace(xml, cells)
    const rowBelow = rowBelowPicture(xml)
    const sheetRels = await parseRels(zip, relsPart(part))
    for (const d of xml.matchAll(/<(?:[\w.-]+:)?drawing\b[^>]*\sr:id=["']([^"']+)["']/g)) {
      const rel = sheetRels.get(d[1]!)
      const drawing =
        rel && rel.targetMode !== 'External' && resolveRelationshipTargetPath(part, rel.target)
      if (!drawing) continue
      const drawings = anchors((await zip.file(drawing)?.async('string')) ?? '', rowBelow)
      const images = await parseRels(zip, relsPart(drawing))
      for (const item of drawings) {
        for (const id of item.embeds) {
          const img = images.get(id)
          if (!img || img.targetMode === 'External' || !img.type.endsWith('/image')) continue
          const path = resolveRelationshipTargetPath(drawing, img.target)
          if (!path || !zip.file(path)) continue
          hasScan = true
          if (!cached.has(path)) {
            const pages = await recognizedPicturePages(
              await zip.file(path)!.async('uint8array'),
              pdfium,
              ocr,
              true,
            )
            const page = pages.find(
              (page) =>
                !page.scanned &&
                !page.degraded &&
                page.blocks.some((b) => b.kind === 'text' || b.kind === 'table'),
            )
            cached.set(path, page ? recognizedPageGrid(page) : null)
          }
          const grid = cached.get(path)
          if (!grid || !grid.cells.some((c) => c.value)) continue
          const anchor =
            placement === 'below'
              ? item.from && item.bottom !== undefined
                ? { row: item.bottom, column: item.from.column }
                : undefined
              : item.from
          const from = selected?.offset ?? anchor ?? origin
          const bounds = {
            startRow: from.row,
            endRow: from.row,
            startColumn: from.column,
            endColumn: from.column,
          }
          for (const cell of grid.cells) {
            bounds.endRow = Math.max(bounds.endRow, from.row + cell.row)
            bounds.endColumn = Math.max(bounds.endColumn, from.column + cell.col)
          }
          for (const ref of plainText ? [] : (grid.merges ?? [])) {
            const range = cellRange(ref, from)!
            bounds.endRow = Math.max(bounds.endRow, range.endRow)
            bounds.endColumn = Math.max(bounds.endColumn, range.endColumn)
          }
          const fits =
            !!anchor &&
            (placement === 'below' || (item.simple && !grid.hasArtwork)) &&
            !protectedSheet &&
            bounds.endRow < 1_048_576 &&
            bounds.endColumn < 16_384 &&
            !blocked.some((r) => overlaps(r, bounds)) &&
            !drawings.some(
              (other) => other !== item && (!other.area || overlaps(other.area, bounds)),
            ) &&
            !occupied.some((r) => overlaps(r, bounds))
          const name =
            destination?.sheet ??
            (fits ? sheet.name : newSheetName(sheet.name, item.from, usedNames))
          const offset = selected ? { ...selected.offset } : fits ? from : origin
          if (selected) {
            if (bounds.endRow >= 1_048_576 || bounds.endColumn >= 16_384)
              throw Error('OCR_SHEET_GRID_LIMIT')
            if (selected.blockers.some((r) => overlaps(r, bounds)))
              throw Error('OCR_SHEET_DESTINATION_OCCUPIED')
            selected.offset.row = bounds.endRow + 2
          } else if (fits) {
            blocked.push(bounds)
            if (placement === 'replace')
              visuals.push({ drawingPath: drawing, drawingIndex: item.index, remove: true })
          } else newSheets.push(name)
          for (const cell of grid.cells) {
            const row = cell.row + offset.row,
              column = cell.col + offset.column
            const style =
              !plainText &&
              outputCellStyle(
                grid.styles[cell.styleId],
                selected
                  ? selected.styledCells.has(cellAddress(row, column))
                  : fits && styledCells.has(cellAddress(row, column)),
              )
            if (!cell.value && !style) continue
            edits.push({
              sheetName: name,
              row,
              column,
              writeValue: !!cell.value,
              cell: {
                value: cell.value
                  ? cell.value.kind === 'text'
                    ? cell.value.text
                    : cell.value.value
                  : null,
              },
              ...(style ? { style } : {}),
            })
          }
          const ops = structure.get(name) ?? []
          for (const ref of plainText ? [] : (grid.merges ?? []))
            ops.push({ kind: 'merge-cells', range: cellRange(ref, offset)! })
          if (!plainText && (destination ? destination.kind === 'xlsx-new-sheet' : !fits)) {
            grid.colWidths?.forEach((width, index) => {
              if (width === undefined) return
              const col = offset.column + index
              if (destination)
                requestedColumnWidths.set(col, Math.max(requestedColumnWidths.get(col) ?? 0, width))
              else ops.push({ kind: 'set-col-size', start: col, end: col, size: width })
            })
            for (const [index, size] of grid.rowHeightsPt ?? []) {
              const row = offset.row + index
              ops.push({ kind: 'set-row-size', start: row, end: row, size })
            }
          }
          structure.set(name, ops)
        }
      }
    }
  }
  if (!edits.length) {
    if (destination || hasScan || !hasNativeText) throw Error('OCR_NO_TEXT')
    await writeFile(output, source)
    return
  }
  if (
    newSheets.length &&
    /<(?:[\w.-]+:)?workbookProtection\b[^>]*\blockStructure=["'](?:true|1)["']/.test(bookXml)
  )
    throw Error('OCR results need a new sheet, but the workbook structure is protected.')
  if (destination?.kind === 'xlsx-new-sheet') {
    const ops = structure.get(destination.sheet)!
    for (const [column, size] of requestedColumnWidths)
      ops.push({ kind: 'set-col-size', start: column, end: column, size })
  }
  const structuralOps: SheetStructuralOps[] = Array.from(structure, ([sheetName, ops]) => ({
    sheetName,
    ops,
  }))
  await writeWorkbook(source, edits, output, {
    structuralOps,
    visualEdits: visuals,
    ...(newSheets.length
      ? {
          plan: {
            renames: [],
            removals: [],
            additions: newSheets.map((name) => ({ name })),
            order: [...names, ...newSheets],
          },
        }
      : {}),
  })
}
