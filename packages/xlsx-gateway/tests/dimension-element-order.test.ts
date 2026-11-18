import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'

import { csvToXlsxBuffer } from '../src/gateway/csv-import'
import { applyCellEditsToXlsx, createBufferEntrySource } from '../src/gateway/xlsx-gateway'

// CT_Worksheet is a sequence: sheetPr, dimension, sheetViews, sheetFormatPr, cols, sheetData ...
// Excel refuses a sheet that breaks it ("Load error" in /xl/worksheets/sheet1.xml and a repair
// prompt), so a <dimension> added to a sheet that had none has to land after <sheetPr>.

/** the workbook of a one-column csv, its sheet rewritten to `sheetXml` */
async function workbookWithSheet(sheetXml: string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await csvToXlsxBuffer('value\n1'))
  zip.file('xl/worksheets/sheet1.xml', sheetXml)
  return zip.generateAsync({ type: 'nodebuffer' })
}

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
const ROWS = '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>'

async function savedSheet(source: Buffer): Promise<string> {
  const mutation = await applyCellEditsToXlsx(source, [
    { sheetName: 'Sheet1', row: 4, column: 3, writeValue: true, cell: { value: 'x' } },
  ])
  return (await createBufferEntrySource(mutation.buffer)).readText('xl/worksheets/sheet1.xml')
}

/** the order of the worksheet's children as written */
function childOrder(xml: string, names: readonly string[]): string[] {
  return [...xml.matchAll(new RegExp(`<(${names.join('|')})\\b`, 'g'))].map((m) => m[1] as string)
}

describe('a dimension added to a sheet that had none', () => {
  it('goes after sheetPr, not in front of it', async () => {
    const source = await workbookWithSheet(
      `<?xml version="1.0"?><worksheet ${NS}><sheetPr><tabColor rgb="FFFFFF00"/></sheetPr>` +
        `<sheetViews><sheetView workbookViewId="0"/></sheetViews>${ROWS}</worksheet>`,
    )
    const xml = await savedSheet(source)
    expect(childOrder(xml, ['sheetPr', 'dimension', 'sheetViews', 'sheetData'])).toEqual([
      'sheetPr',
      'dimension',
      'sheetViews',
      'sheetData',
    ])
    expect(xml).toContain('<dimension ref="A1:D5"/>')
  })

  it('goes after a self-closing sheetPr too', async () => {
    const source = await workbookWithSheet(
      `<worksheet ${NS}><sheetPr codeName="Sheet1"/>${ROWS}</worksheet>`,
    )
    const xml = await savedSheet(source)
    expect(childOrder(xml, ['sheetPr', 'dimension', 'sheetData'])).toEqual([
      'sheetPr',
      'dimension',
      'sheetData',
    ])
  })

  it('still opens the worksheet when there is no sheetPr', async () => {
    const source = await workbookWithSheet(`<worksheet ${NS}>${ROWS}</worksheet>`)
    const xml = await savedSheet(source)
    expect(childOrder(xml, ['dimension', 'sheetData'])).toEqual(['dimension', 'sheetData'])
    expect(xml).toMatch(/<worksheet [^>]*><dimension ref="A1:D5"\/>/)
  })
})
