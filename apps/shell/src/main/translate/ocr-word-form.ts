import { generateTableModelXml } from '../../../../../packages/docx-engine/src/generate'
import type { TableCell } from '../../../../../packages/docx-engine/src/types'
import type { AiReadPagePayload } from '../../../../../packages/pdf-structure/src/ai-read/content'
import { runsText } from '../../../../../packages/pdf-structure/src/tree/inline'
import type { TreeTable } from '../../../../../packages/pdf-structure/src/tree/types'

/** Word stores an explicit continuation cell in every row covered by a vertical merge. */
function wordTable(table: TreeTable): string | undefined {
  const { rowCount, colCount } = table
  if (!rowCount || !colCount || colCount > 63 || rowCount * colCount > 200000) return
  const cells = new Map<number, TableCell>()
  for (const cell of table.cells) {
    const { row, col, rowSpan, colSpan } = cell
    for (let r = row; r < row + rowSpan; r++) {
      const key = r * colCount + col
      if (cells.has(key)) return
      cells.set(key, {
        paras: r === row ? cell.paragraphs.map(runsText) : [],
        colSpan,
        ...(cell.header && { bold: true }),
        ...(rowSpan > 1 && { vMerge: r === row ? 'restart' : 'continue' }),
      })
    }
  }
  const rows: TableCell[][] = []
  for (let r = 0; r < rowCount; r++) {
    const row: TableCell[] = []
    for (let c = 0; c < colCount;) {
      const cell = cells.get(r * colCount + c) ?? { paras: [] }
      row.push(cell)
      c += cell.colSpan ?? 1
    }
    rows.push(row)
  }
  return generateTableModelXml({ rows, widthPct: 100, autoFit: 'window' })
}

/** Only values from the checked OCR payload enter Word's generator, including for a table inside an existing cell. */
export function ocrWordFormXml(
  form: AiReadPagePayload,
  paragraph: (text: string) => string,
): string | undefined {
  const parts: string[] = []
  for (const block of form.blocks) {
    if ('runs' in block) parts.push(paragraph(runsText(block.runs)))
    else if (block.kind === 'math') parts.push(paragraph(block.latex))
    else {
      const caption = block.caption ? paragraph(runsText(block.caption.runs)) : ''
      if (block.caption?.position === 'above') parts.push(caption)
      if (block.kind === 'table') {
        const xml = wordTable(block.table)
        if (!xml) return
        parts.push(xml)
      }
      if (block.caption?.position === 'below') parts.push(caption)
    }
  }
  for (const note of form.footnotes)
    parts.push(paragraph(note.label + ' ' + note.paragraphs.map(runsText).join('\n')))
  return parts.join('')
}
