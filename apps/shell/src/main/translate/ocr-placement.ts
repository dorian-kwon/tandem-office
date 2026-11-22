import {
  applyCellEditsToXlsx,
  readBasicWorkbook,
  type CellEdit,
} from '../../../../../packages/xlsx-gateway/src/gateway/xlsx-gateway'
import { loadDocxZip } from '../../../../../packages/docx-engine/src/zip-load'
import type { OcrPlacement } from '../../shared/translate-ocr'
import { TranslateIpcError } from '../../shared/translate-api'
import { placeOcrTextInDocx, type OcrTextItem } from './ocr-docx-placement'
import { wordTables } from './ocr-word-tables'
import type {
  CellArea,
  StructuralOp,
} from '../../../../../packages/xlsx-gateway/src/gateway/xlsx-structure'
import { sheetFormRows } from './ocr-xlsx-form'
import { cellAddress, xlsxStructure } from './ocr-xlsx-structure'
export type { OcrTextItem }
function invalid(message: string): never {
  throw new TranslateIpcError('INVALID_ARGUMENT', message)
}
export async function ocrSheetNames(bytes: Uint8Array): Promise<string[]> {
  return (await readBasicWorkbook(Buffer.from(bytes))).snapshot.sheets.map((s) => s.name)
}

export async function ocrWordTables(bytes: Uint8Array) {
  const zip = await loadDocxZip(bytes)
  return wordTables(await zip.file('word/document.xml')!.async('string'))
}

/** Apply only the placement the person selected, preserving the source package and media. */
export async function placeOcrText(
  bytes: Uint8Array,
  format: 'xlsx' | 'docx',
  items: OcrTextItem[],
  choice: unknown,
): Promise<Uint8Array> {
  if (!choice || typeof choice !== 'object') invalid('choose where the OCR text goes')
  const picked = choice as OcrPlacement
  if (format === 'xlsx') {
    if (picked.kind !== 'xlsx-cells' && picked.kind !== 'xlsx-new-sheet')
      invalid('choose an Excel destination')
    const p = picked
    if (typeof p.sheet !== 'string' || !p.sheet.trim()) invalid('choose a sheet')
    const source = Buffer.from(bytes)
    const structure = await xlsxStructure(source)
    const names = structure.sheets.map((s) => s.name)
    let row = 0,
      column = 0
    if (p.kind === 'xlsx-cells') {
      const match =
        typeof p.cell === 'string' ? p.cell.toUpperCase().match(/^([A-Z]{1,3})([1-9]\d*)$/) : null
      if (!match || !names.includes(p.sheet) || typeof p.overwrite !== 'boolean')
        invalid('choose a valid sheet and cell')
      for (const ch of match![1]!) column = column * 26 + ch.charCodeAt(0) - 64
      column--
      row = Number(match![2]) - 1
      if (column >= 16384 || row + items.length > 1048576)
        invalid('the destination exceeds the sheet grid')
    } else if (
      names.some((n) => n.toLowerCase() === p.sheet.toLowerCase()) ||
      p.sheet.length > 31 ||
      ['\\', '/', '?', '*', '[', ']', ':'].some((char) => p.sheet.includes(char)) ||
      p.sheet.startsWith("'") ||
      p.sheet.endsWith("'")
    )
      invalid('choose a new sheet name')
    const selected = structure.sheets.find((s) => s.name === p.sheet)
    if (
      structure.protectedSheets.has(p.sheet) ||
      (p.kind === 'xlsx-new-sheet' && structure.structureLocked)
    )
      invalid('the destination is protected')
    const edits: CellEdit[] = []
    const ops: StructuralOp[] = []
    function requireSpace(area: CellArea) {
      if (area.endRow >= 1048576 || area.endColumn >= 16384)
        invalid('the destination exceeds the sheet grid')
      if (
        structure.merges
          .get(p.sheet)
          ?.some(
            (m) =>
              m.row <= area.endRow &&
              area.startRow <= m.lastRow &&
              m.column <= area.endColumn &&
              area.startColumn <= m.lastColumn,
          )
      )
        invalid('the destination intersects an existing merged range')
      // A merged or empty table cell must never hide a pre-existing value or formula.
      if (selected)
        for (let r = area.startRow; r <= area.endRow; r++) {
          for (let c = area.startColumn; c <= area.endColumn; c++) {
            const cell = selected.cells[cellAddress(r, c)]
            if (cell && (cell.formula || (cell.value !== null && cell.value !== '')))
              invalid('choose an empty range for the OCR table')
          }
        }
    }
    function put(r: number, c: number, text: string) {
      if (r >= 1048576 || c >= 16384) invalid('the destination exceeds the sheet grid')
      const existing = selected?.cells[cellAddress(r, c)]
      if (structure.isFollower(p.sheet, r, c)) invalid('choose the first cell of a merged range')
      if (text.length > 32767) invalid('OCR text exceeds the Excel cell text limit')
      if (
        p.kind === 'xlsx-cells' &&
        !p.overwrite &&
        existing &&
        (existing.formula || (existing.value !== null && existing.value !== ''))
      )
        invalid('the destination has content; allow replacement or choose empty cells')
      edits.push({ sheetName: p.sheet, row: r, column: c, writeValue: true, cell: { value: text } })
    }
    for (const item of items) {
      if (item.form)
        row = sheetFormRows(item.form, row, column, put, requireSpace, (range) =>
          ops.push({ kind: 'merge-cells', range }),
        )
      else put(row++, column, item.text)
    }
    const plan =
      p.kind === 'xlsx-new-sheet'
        ? { renames: [], removals: [], additions: [{ name: p.sheet }], order: [...names, p.sheet] }
        : undefined
    return (
      await applyCellEditsToXlsx(
        source,
        edits,
        ops.length ? [{ sheetName: p.sheet, ops }] : [],
        [],
        plan,
      )
    ).buffer
  }
  return placeOcrTextInDocx(bytes, items, choice)
}
