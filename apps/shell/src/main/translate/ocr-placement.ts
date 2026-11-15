import {
  applyCellEditsToXlsx,
  readBasicWorkbook,
} from '../../../../../packages/xlsx-gateway/src/gateway/xlsx-gateway'
import { loadDocxZip } from '../../../../../packages/docx-engine/src/zip-load'
import type { OcrPlacement } from '../../shared/translate-ocr'
import { TranslateIpcError } from '../../shared/translate-api'
import { placeOcrTextInDocx, type OcrTextItem } from './ocr-docx-placement'
import { wordTables } from './ocr-word-tables'
import { xlsxStructure } from './ocr-xlsx-structure'
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
  const p = choice as OcrPlacement
  if (format === 'xlsx') {
    if (p.kind !== 'xlsx-cells' && p.kind !== 'xlsx-new-sheet')
      invalid('choose an Excel destination')
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
    const edits = items.map((item, i) => {
      let n = column + 1,
        letters = ''
      while (n > 0) {
        letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters
        n = Math.floor((n - 1) / 26)
      }
      const existing = selected?.cells[`${letters}${row + i + 1}`]
      if (structure.isFollower(p.sheet, row + i, column))
        invalid('choose the first cell of a merged range')
      if (item.text.length > 32767) invalid('OCR text exceeds the Excel cell text limit')
      if (
        p.kind === 'xlsx-cells' &&
        !p.overwrite &&
        existing &&
        (existing.formula || (existing.value !== null && existing.value !== ''))
      )
        invalid('the destination has content; allow replacement or choose empty cells')
      return {
        sheetName: p.sheet,
        row: row + i,
        column,
        writeValue: true,
        cell: { value: item.text },
      }
    })
    const plan =
      p.kind === 'xlsx-new-sheet'
        ? { renames: [], removals: [], additions: [{ name: p.sheet }], order: [...names, p.sheet] }
        : undefined
    return (await applyCellEditsToXlsx(source, edits, [], [], plan)).buffer
  }
  return placeOcrTextInDocx(bytes, items, choice)
}
