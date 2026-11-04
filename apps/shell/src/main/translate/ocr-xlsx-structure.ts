import { posix } from 'node:path'
import { loadDocxZip } from '../../../../../packages/docx-engine/src/zip-load'
import { readBasicWorkbook } from '../../../../../packages/xlsx-gateway/src/gateway/xlsx-gateway'
import {
  parseSheetElements,
  parseRelationships,
} from '../../../../../packages/xlsx-gateway/src/gateway/xlsx-sheets'
import { TranslateIpcError } from '../../shared/translate-api'
export function cellPosition(address: string) {
  const match = address.toUpperCase().match(/^([A-Z]{1,3})([1-9]\d*)$/)
  if (!match) return null
  let column = 0
  for (const char of match[1]!) column = column * 26 + char.charCodeAt(0) - 64
  const row = Number(match[2]) - 1
  column--
  return column < 16384 && row < 1048576 ? { row, column } : null
}
export function cellAddress(row: number, column: number) {
  let letters = ''
  for (let n = column + 1; n > 0; n = Math.floor((n - 1) / 26))
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters
  return letters + (row + 1)
}
export async function xlsxStructure(bytes: Uint8Array) {
  const workbook = (await readBasicWorkbook(Buffer.from(bytes))).snapshot
  const zip = await loadDocxZip(bytes)
  const sheets = parseSheetElements(await zip.file('xl/workbook.xml')!.async('string'))
  const rels = parseRelationships(await zip.file('xl/_rels/workbook.xml.rels')!.async('string'))
  const merges = new Map<
    string,
    { row: number; column: number; lastRow: number; lastColumn: number }[]
  >()
  for (const sheet of sheets) {
    const rel = rels.find((r) => r.id === sheet.relationshipId && !r.external)
    if (!rel) continue
    const target = rel.target.replace(/\\/g, '/')
    const path = target.startsWith('/')
      ? target.slice(1)
      : target.startsWith('xl/')
        ? target
        : posix.normalize(posix.join('xl', target))
    const file = zip.file(path)
    if (!file) throw new TranslateIpcError('INVALID_ARGUMENT', 'the worksheet part is missing')
    const ranges = []
    for (const m of (await file.async('string')).matchAll(
      /<mergeCell\b[^>]*\bref=["']([^"']+)["']/g,
    )) {
      const [a, b] = m[1]!.split(':')
      const first = cellPosition(a!)
      const last = cellPosition(b ?? a!)
      if (!first || !last || last.row < first.row || last.column < first.column)
        throw new TranslateIpcError('INVALID_ARGUMENT', 'unsupported merged range')
      ranges.push({ ...first, lastRow: last.row, lastColumn: last.column })
    }
    merges.set(sheet.name, ranges)
  }
  const isFollower = (sheet: string, row: number, column: number) =>
    (merges.get(sheet) ?? []).some(
      (m) =>
        row >= m.row &&
        row <= m.lastRow &&
        column >= m.column &&
        column <= m.lastColumn &&
        (row !== m.row || column !== m.column),
    )
  return { sheets: workbook.sheets, isFollower }
}
