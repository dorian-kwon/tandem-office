import { runsText } from '../../../../../packages/pdf-structure/src/tree/inline'
import type { AiReadPagePayload } from '../../../../../packages/pdf-structure/src/ai-read/content'
import type { CellArea } from '../../../../../packages/xlsx-gateway/src/gateway/xlsx-structure'
import { TranslateIpcError } from '../../shared/translate-api'

/** Preserve rows and spans from the checked OCR reading. Only selected pictures reach this writer. */
export function sheetFormRows(
  form: AiReadPagePayload,
  row: number,
  column: number,
  put: (row: number, column: number, text: string) => void,
  tableArea: (area: CellArea) => void,
  merge: (area: CellArea) => void,
) {
  function line(text: string) {
    put(row++, column, text)
  }
  for (const block of form.blocks) {
    if ('runs' in block) line(runsText(block.runs))
    else if (block.kind === 'math') line(block.latex)
    else {
      if (block.caption?.position === 'above') line(runsText(block.caption.runs))
      if (block.kind === 'table') {
        const { cells, colCount, rowCount } = block.table
        if (rowCount * colCount > 200000 || !rowCount || !colCount)
          throw new TranslateIpcError('INVALID_ARGUMENT', 'unsupported OCR table dimensions')
        tableArea({
          startRow: row,
          endRow: row + rowCount - 1,
          startColumn: column,
          endColumn: column + colCount - 1,
        })
        const used = new Uint8Array(rowCount * colCount)
        for (const cell of cells) {
          const r = row + cell.row,
            c = column + cell.col
          for (let i = cell.row; i < cell.row + cell.rowSpan; i++) {
            for (let j = cell.col; j < cell.col + cell.colSpan; j++) {
              const k = i * colCount + j
              if (used[k])
                throw new TranslateIpcError('INVALID_ARGUMENT', 'overlapping OCR table cells')
              used[k] = 1
            }
          }
          put(r, c, cell.paragraphs.map(runsText).join('\n'))
          if (cell.rowSpan > 1 || cell.colSpan > 1)
            merge({
              startRow: r,
              startColumn: c,
              endRow: r + cell.rowSpan - 1,
              endColumn: c + cell.colSpan - 1,
            })
        }
        row += rowCount
      }
      if (block.caption?.position === 'below') line(runsText(block.caption.runs))
    }
  }
  for (const note of form.footnotes)
    line(note.label + ' ' + note.paragraphs.map(runsText).join('\n'))
  return row
}
