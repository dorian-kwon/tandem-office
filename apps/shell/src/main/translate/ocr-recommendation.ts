import { loadDocxZip } from '../../../../../packages/docx-engine/src/zip-load'
import type { OcrRecommendation } from '../../shared/translate-ocr'
import { xlsxStructure, cellAddress, cellPosition } from './ocr-xlsx-structure'
import { recommendWordCell } from './ocr-word-tables'
export async function recommendOcrPlacement(
  bytes: Uint8Array,
  format: 'xlsx' | 'docx',
  items: { location: string }[],
): Promise<OcrRecommendation> {
  if (format === 'docx') {
    const zip = await loadDocxZip(bytes)
    const xml = await zip.file('word/document.xml')!.async('string')
    const placement = items[0] && recommendWordCell(xml, items[0].location, items.length)
    return placement
      ? { placement, reason: 'empty-cells' }
      : { placement: { kind: 'docx-after-images' }, reason: 'after-images' }
  }
  const structure = await xlsxStructure(bytes)
  const location = items[0]?.location
  const split = location?.lastIndexOf(' · ') ?? -1
  const name = location?.slice(0, split)
  const anchor = split >= 0 ? cellPosition(location!.slice(split + 3)) : null
  const sheet = structure.sheets.find((s) => s.name === name)
  if (sheet && anchor && items.every((i) => i.location.startsWith(sheet.name + ' · '))) {
    const headers = Object.entries(sheet.cells)
      .filter(([address, state]) => {
        const at = cellPosition(address)
        const text = String(state.value ?? '')
        return (
          at &&
          at.row < 6 &&
          at.column > anchor.column &&
          /번역|감수|translat|target|review|訳|译/.test(text.toLowerCase()) &&
          !/소스|원문|source/.test(text.toLowerCase())
        )
      })
      .map(([address]) => cellPosition(address)!.column)
    const candidates = [
      ...new Set([...headers, anchor.column + 1, anchor.column + 2, anchor.column + 3]),
    ]
    for (const column of candidates) {
      if (column >= 16384 || anchor.row + items.length > 1048576) continue
      const safe = items.every((_, i) => {
        const address = cellAddress(anchor.row + i, column)
        const cell = sheet.cells[address]
        return (
          !structure.isFollower(sheet.name, anchor.row + i, column) &&
          (!cell || (!cell.formula && (cell.value === null || cell.value === '')))
        )
      })
      if (safe)
        return {
          placement: {
            kind: 'xlsx-cells',
            sheet: sheet.name,
            cell: cellAddress(anchor.row, column),
            overwrite: false,
          },
          reason: 'empty-cells',
        }
    }
  }
  let nameForNew = 'OCR'
  for (
    let n = 2;
    structure.sheets.some((s) => s.name.toLowerCase() === nameForNew.toLowerCase());
    n++
  )
    nameForNew = `OCR (${n})`
  return { placement: { kind: 'xlsx-new-sheet', sheet: nameForNew }, reason: 'new-sheet' }
}
