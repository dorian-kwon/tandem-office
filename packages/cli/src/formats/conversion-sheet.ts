import { ensureDom } from '../dom'
import { bodyBlocks } from './conversion-html'
import {
  htmlTablesToXlsxBuffer,
  parseHtmlTables,
} from '@genoffice/xlsx-gateway/gateway/html-import'
import { parseCsv } from '@genoffice/xlsx-gateway/gateway/csv-import'
import { visitFormattedSheets } from './xlsx'

export async function bodyHtmlToWorkbook(html: string, sheet: string): Promise<Uint8Array> {
  await ensureDom()
  const { body } = new DOMParser().parseFromString(html, 'text/html')
  const table = body.ownerDocument.createElement('table')
  // Paragraphs get their own row. Preserve cells and merges when a body table
  // contributes rows; a nested table stays inside its parent cell as text.
  for (const block of bodyBlocks(body)) {
    if (block.tagName === 'TABLE') {
      for (const row of Array.from((block as HTMLTableElement).rows)) table.append(row)
    } else {
      table.insertRow().insertCell().textContent = block.textContent
    }
  }
  const grids = parseHtmlTables(table.outerHTML)
  return htmlTablesToXlsxBuffer(grids.length ? grids : [{ rows: [], merges: [] }], sheet)
}

export async function workbookBodyHtml(path: string): Promise<string> {
  const text = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const parts: string[] = []
  await visitFormattedSheets(path, (sheet) => {
    parts.push('<h2>', text(sheet.sheet), '</h2>')
    if (!sheet.csv) return
    parts.push('<table>')
    for (const row of parseCsv(sheet.csv, ',')) {
      parts.push(
        '<tr>',
        ...row.map((cell) => '<td>' + text(cell).replace(/\r\n|\n|\r/g, '<br>') + '</td>'),
        '</tr>',
      )
    }
    parts.push('</table>')
  })
  return parts.join('')
}
