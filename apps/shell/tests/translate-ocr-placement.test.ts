import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { placeOcrText } from '../src/main/translate/ocr-placement'
const image = Buffer.from([1, 2, 3, 4])
async function xlsx() {
  const z = new JSZip()
  z.file(
    '[Content_Types].xml',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
  )
  z.file(
    'xl/workbook.xml',
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Original" sheetId="1" r:id="rId1"/></sheets></workbook>',
  )
  z.file(
    'xl/_rels/workbook.xml.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  )
  z.file(
    'xl/worksheets/sheet1.xml',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Original value</t></is></c></row></sheetData><drawing r:id="draw"/></worksheet>',
  )
  z.file('xl/media/image1.png', image)
  return z.generateAsync({ type: 'nodebuffer' })
}
describe('OCR placement in the source format', () => {
  it('keeps the workbook, media and original values while putting OCR in the chosen cells', async () => {
    const source = await xlsx()
    const result = await placeOcrText(
      source,
      'xlsx',
      [{ index: 1, text: 'Recognised text', location: 'Original · A7' }],
      { kind: 'xlsx-cells', sheet: 'Original', cell: 'C7', overwrite: false },
    )
    const z = await JSZip.loadAsync(result)
    expect(await z.file('xl/media/image1.png')!.async('nodebuffer')).toEqual(image)
    const xml = await z.file('xl/worksheets/sheet1.xml')!.async('string')
    expect(xml).toContain('Original value')
    expect(xml).toContain('C7')
    expect(xml).toContain('Recognised text')
    expect(xml).toContain('<drawing')
  })
  it('requires explicit placement and refuses to overwrite occupied cells without permission', async () => {
    const source = await xlsx()
    await expect(
      placeOcrText(source, 'xlsx', [{ index: 1, text: 'OCR' }], undefined),
    ).rejects.toThrow()
    await expect(
      placeOcrText(source, 'xlsx', [{ index: 1, text: 'OCR' }], {
        kind: 'xlsx-cells',
        sheet: 'Original',
        cell: 'A1',
        overwrite: false,
      }),
    ).rejects.toThrow()
  })
  it('adds a requested OCR sheet while keeping existing sheet bytes unchanged', async () => {
    const source = await xlsx()
    const result = await placeOcrText(source, 'xlsx', [{ index: 1, text: 'OCR' }], {
      kind: 'xlsx-new-sheet',
      sheet: 'OCR results',
    })
    const before = await JSZip.loadAsync(source)
    const after = await JSZip.loadAsync(result)
    expect(await after.file('xl/worksheets/sheet1.xml')!.async('string')).toBe(
      await before.file('xl/worksheets/sheet1.xml')!.async('string'),
    )
    expect(await after.file('xl/workbook.xml')!.async('string')).toContain('OCR results')
  })
  it('keeps DOCX images and existing paragraphs and inserts OCR after the chosen picture paragraph', async () => {
    const z = new JSZip()
    z.file(
      'word/document.xml',
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Before</w:t></w:r></w:p><w:p><w:r><w:drawing/></w:r></w:p><w:p><w:r><w:t>After</w:t></w:r></w:p><w:sectPr/></w:body></w:document>',
    )
    z.file('word/media/a.png', image)
    const source = await z.generateAsync({ type: 'nodebuffer' })
    const result = await placeOcrText(
      source,
      'docx',
      [{ index: 1, text: 'OCR & text', location: 'document.xml · ¶2' }],
      { kind: 'docx-after-images' },
    )
    const out = await JSZip.loadAsync(result)
    const xml = await out.file('word/document.xml')!.async('string')
    expect(xml.indexOf('Before')).toBeLessThan(xml.indexOf('OCR &amp; text'))
    expect(xml.indexOf('OCR &amp; text')).toBeLessThan(xml.indexOf('After'))
    expect(await out.file('word/media/a.png')!.async('nodebuffer')).toEqual(image)
  })
})

it('places Word OCR in the requested table cell while preserving merged cells, table properties and images', async () => {
  const z = new JSZip()
  const cell1 =
    '<w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:drawing/></w:r></w:p></w:tc>'
  const cell2 =
    '<w:tc><w:tcPr><w:shd w:fill="FFFF00"/></w:tcPr><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t></w:t></w:r></w:p></w:tc>'
  z.file(
    'word/document.xml',
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl><w:tblPr><w:tblStyle w:val="OriginalStyle"/></w:tblPr><w:tr>${cell1}${cell2}</w:tr></w:tbl><w:sectPr/></w:body></w:document>`,
  )
  z.file('word/media/a.png', image)
  const source = await z.generateAsync({ type: 'nodebuffer' })
  const placement = {
    kind: 'docx-table-cell' as const,
    table: 1,
    row: 1,
    column: 3,
    overwrite: false,
  }
  const output = await placeOcrText(
    source,
    'docx',
    [{ index: 1, text: 'OCR into a cell' }],
    placement,
  )
  const out = await JSZip.loadAsync(output)
  const xml = await out.file('word/document.xml')!.async('string')
  expect(xml).toContain(cell1)
  expect(xml).toContain('OriginalStyle')
  expect(xml).toContain('w:fill="FFFF00"')
  expect(xml).toContain('w:val="center"')
  expect(xml).toContain('OCR into a cell')
  expect(await out.file('word/media/a.png')!.async('nodebuffer')).toEqual(image)
  await expect(
    placeOcrText(source, 'docx', [{ index: 1, text: 'OCR' }], { ...placement, column: 2 }),
  ).rejects.toThrow()
  await expect(
    placeOcrText(source, 'docx', [{ index: 1, text: 'OCR' }], {
      ...placement,
      column: 1,
      overwrite: true,
    }),
  ).rejects.toThrow()
})

it('rejects merged follower destinations in Excel', async () => {
  const z = await JSZip.loadAsync(await xlsx())
  const part = 'xl/worksheets/sheet1.xml'
  z.file(
    part,
    (await z.file(part)!.async('string')).replace(
      '</worksheet>',
      '<mergeCells count="1"><mergeCell ref="B3:C3"/></mergeCells></worksheet>',
    ),
  )
  await expect(
    placeOcrText(
      await z.generateAsync({ type: 'nodebuffer' }),
      'xlsx',
      [{ index: 1, text: 'OCR' }],
      { kind: 'xlsx-cells', sheet: 'Original', cell: 'C3', overwrite: true },
    ),
  ).rejects.toThrow('merged')
})
it('preserves equations unless cell replacement is explicitly allowed', async () => {
  const z = new JSZip()
  z.file(
    'word/document.xml',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl><w:tr><w:tc><w:p><m:oMath><m:r><m:t>x=2</m:t></m:r></m:oMath></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
  )
  await expect(
    placeOcrText(
      await z.generateAsync({ type: 'nodebuffer' }),
      'docx',
      [{ index: 1, text: 'OCR' }],
      { kind: 'docx-table-cell', table: 1, row: 1, column: 1, overwrite: false },
    ),
  ).rejects.toThrow('content')
})
it('recommends an empty neighbouring cell based on the Excel image location', async () => {
  const { recommendOcrPlacement } = await import('../src/main/translate/ocr-recommendation')
  expect(
    await recommendOcrPlacement(await xlsx(), 'xlsx', [{ location: 'Original · A7' }]),
  ).toEqual({
    placement: { kind: 'xlsx-cells', sheet: 'Original', cell: 'B7', overwrite: false },
    reason: 'empty-cells',
  })
})
