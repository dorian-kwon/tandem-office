import { existsSync } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { parseCsv, resolveImportDelimiter } from '@genoffice/xlsx-gateway/gateway/csv-import'
import { decodeCsv } from '../../../../packages/cli/src/formats/csv'
import {
  visitWorkbookTables,
  type CellArea,
  type SheetPicture,
} from '../../../../packages/cli/src/formats/xlsx'
import { escapeText } from '../../../../packages/pdf-structure/src/epub/xml'

/** Keep each worksheet as an editable table, with pictures in their anchor cells. */
function* sheetTable(
  rows: string[][],
  merges: CellArea[],
  pictures: SheetPicture[],
): Generator<string> {
  const cells = new Map<string, string>()
  const floats: string[] = []
  let height = rows.length
  let width = rows.reduce((max, row) => Math.max(max, row.length), 0)
  const starts = new Map<number, CellArea[]>()
  for (const area of merges) {
    height = Math.max(height, area.endRow + 1)
    width = Math.max(width, area.endColumn + 1)
    const group = starts.get(area.startRow) ?? []
    group.push(area)
    starts.set(area.startRow, group)
  }
  for (const picture of pictures) {
    const { row, column } = picture
    const img = '<img src="data:' + picture.mediaType + ';base64,' + picture.base64 + '">'
    // A floating image may sit well outside the used cells. Keep it on this sheet
    // without generating a grid of empty rows/columns out to a distant anchor.
    if (row >= height || column >= width) {
      floats.push('<p>' + img + '</p>')
      continue
    }
    const owner = merges.find(
      (a) =>
        a.startRow <= row && row <= a.endRow && a.startColumn <= column && column <= a.endColumn,
    )
    const key = [owner?.startRow ?? row, owner?.startColumn ?? column].join(',')
    cells.set(key, (cells.get(key) ?? '') + img)
  }
  if (height && width) {
    yield '<table>'
    let active: CellArea[] = []
    for (let row = 0; row < height; row++) {
      active = active.filter((a) => a.endRow >= row)
      const entering = starts.get(row)
      if (entering) active = active.concat(entering).sort((a, b) => a.startColumn - b.startColumn)
      const parts = ['<tr>']
      let spanIndex = 0
      for (let col = 0; col < width; col++) {
        const span = active[spanIndex]
        let attrs = ''
        let end = col
        if (span && span.startColumn === col) {
          spanIndex++
          end = span.endColumn
          if (row > span.startRow) {
            col = end
            continue
          }
          if (span.endRow > row) attrs += ' rowspan="' + (span.endRow - row + 1) + '"'
          if (end > col) attrs += ' colspan="' + (end - col + 1) + '"'
        }
        const value = escapeText(rows[row]?.[col] ?? '').replace(/\r\n|\r|\n/g, '<br>')
        parts.push(
          '<td' + attrs + '>',
          value,
          cells.size ? (cells.get([row, col].join(',')) ?? '') : '',
          '</td>',
        )
        col = end
      }
      parts.push('</tr>')
      yield parts.join('')
    }
    yield '</table>'
  }
  yield* floats
}

export async function sheetOcrHtml(input: string, htmlOutput: string): Promise<void> {
  const out = await open(htmlOutput, 'w')
  async function writeSheet(
    name: string,
    rows: string[][],
    merges: CellArea[],
    pictures: SheetPicture[],
  ) {
    await out.writeFile('<h2>' + escapeText(name) + '</h2>')
    let chunk = ''
    for (const line of sheetTable(rows, merges, pictures)) {
      chunk += line
      if (chunk.length >= 64 * 1024) {
        await out.writeFile(chunk)
        chunk = ''
      }
    }
    if (chunk) await out.writeFile(chunk)
  }
  try {
    await out.writeFile(
      '<!doctype html><html><head><meta charset="utf-8"><style>' +
        'table{border-collapse:collapse}td{border:1px solid #aaa;padding:2px 4px;vertical-align:top}' +
        'img{max-width:100%;height:auto}</style></head><body>',
    )
    const ext = extname(input).toLowerCase()
    if (ext === '.csv' || ext === '.tsv') {
      const text = decodeCsv(await readFile(input))
      const delimiter = ext === '.tsv' ? '\t' : resolveImportDelimiter(text)
      await writeSheet(basename(input, extname(input)), parseCsv(text, delimiter), [], [])
    } else {
      const native =
        process.resourcesPath &&
        join(
          process.resourcesPath,
          'native',
          process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar',
        )
      await visitWorkbookTables(
        input,
        async (sheet, merges, pictures) => {
          await writeSheet(sheet.sheet, sheet.csv ? parseCsv(sheet.csv, ',') : [], merges, pictures)
        },
        native && existsSync(native) ? native : undefined,
      )
    }
    await out.writeFile('</body></html>')
  } finally {
    await out.close()
  }
}
