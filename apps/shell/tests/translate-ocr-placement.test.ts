import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { parseAiPageResponse } from '../../../packages/pdf-structure/src/ai-read/parse'
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
  z.file(
    'xl/worksheets/_rels/sheet1.xml.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="draw" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>',
  )
  z.file(
    'xl/drawings/drawing1.xml',
    '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"/>',
  )
  z.file('xl/media/image1.png', image)
  return z.generateAsync({ type: 'nodebuffer' })
}
describe('OCR placement in the source format', () => {
  it.each(['existing', 'new'])(
    'writes selected OCR as editable cells and merged ranges in a %s worksheet',
    async (mode) => {
      const form = parseAiPageResponse(
        '<page-content>\n<table><tr><th colspan="2">Amount</th></tr><tr><td rowspan="2">Busan</td><td>23</td></tr><tr><td>42</td></tr></table>\n</page-content>',
        { page: 1, pageFingerprint: '' },
      )
      if (!form.ok) throw Error('invalid fixture')
      const source = await xlsx()
      const chosen = [{ index: 2, text: 'only scan 2', form: form.reading.payload }]
      const location =
        mode === 'existing'
          ? { kind: 'xlsx-cells', sheet: 'Original', cell: 'B2', overwrite: false }
          : { kind: 'xlsx-new-sheet', sheet: 'Read' }
      const out = await JSZip.loadAsync(await placeOcrText(source, 'xlsx', chosen, location))
      const xml = await out
        .file('xl/worksheets/sheet' + (mode === 'existing' ? 1 : 2) + '.xml')!
        .async('string')
      expect(xml).toContain(mode === 'existing' ? 'B2:C2' : 'A1:B1')
      expect(xml).toContain(mode === 'existing' ? 'B3:B4' : 'A2:A3')
      expect(xml).toContain('Busan')
      expect(await out.file('xl/media/image1.png')!.async('nodebuffer')).toEqual(image)
      await expect(
        placeOcrText(source, 'xlsx', chosen, {
          kind: 'xlsx-cells',
          sheet: 'Original',
          cell: 'A1',
          overwrite: true,
        }),
      ).rejects.toThrow('empty range')
    },
  )
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

describe('picture-relative Word OCR placement', () => {
  const part = 'word/document.xml'
  const pic = (id: string) => '<w:r><w:drawing><a:blip r:embed="' + id + '"/></w:drawing></w:r>'
  const p = (text: string) => '<w:p><w:r><w:t>' + text + '</w:t></w:r></w:p>'
  const row = (content: string) =>
    '<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>' +
    content +
    '</w:tc></w:tr></w:tbl>'
  const two = '<w:p>' + pic('second') + pic('third') + '</w:p>'
  const table = row(row(two) + p('end of cell'))
  const first = '<w:p>' + pic('shared') + '</w:p>'
  const words = [
    { index: 2, part, relId: 'second', location: 'document.xml · ¶2', text: 'Two' },
    { index: 3, part, relId: 'third', location: 'document.xml · ¶2', text: 'Three' },
  ]
  async function source() {
    const z = new JSZip()
    z.file(
      part,
      '<w:document xmlns:w="urn:word" xmlns:r="urn:rel" xmlns:a="urn:drawing"><w:body>' +
        first +
        table +
        first +
        p('After') +
        '<w:sectPr/></w:body></w:document>',
    )
    z.file(
      'word/header1.xml',
      '<w:hdr xmlns:w="urn:word" xmlns:a="urn:drawing" xmlns:r="urn:rel">' + first + '</w:hdr>',
    )
    z.file('word/media/source.png', image)
    return z.generateAsync({ type: 'uint8array' })
  }
  it('inserts ordered OCR blocks before the selected nested-cell paragraph', async () => {
    const result = await JSZip.loadAsync(
      await placeOcrText(await source(), 'docx', words, { kind: 'docx-before-images' }),
    )
    const xml = await result.file(part)!.async('string')
    expect(xml).toContain(
      '<w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t xml:space="preserve">Two</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Three</w:t></w:r></w:p>' +
        two,
    )
    expect(xml.match(/>Two<|>Three</g)).toHaveLength(2)
    expect(await result.file('word/media/source.png')!.async('nodebuffer')).toEqual(image)
  })
  it('keeps the original merged tables intact and starts one new body page per shared anchor', async () => {
    const result = await JSZip.loadAsync(
      await placeOcrText(await source(), 'docx', words, { kind: 'docx-next-page' }),
    )
    const xml = await result.file(part)!.async('string')
    const start = xml.indexOf('<w:br w:type="page"/>')
    expect(xml).toContain(table + '<w:p><w:r><w:br w:type="page"/></w:r></w:p>')
    expect(start).toBeGreaterThan(xml.indexOf(table))
    expect(xml.indexOf('Two', start)).toBeLessThan(xml.indexOf('Three', start))
    expect(xml.indexOf('Three', start)).toBeLessThan(xml.indexOf('After', start))
    expect(xml.match(/<w:br w:type="page"\/>/g)).toHaveLength(1)
    expect(xml).toContain('<w:sectPr/></w:body>')
  })
  it('writes editable recognised tables on separate new pages for two body picture paragraphs', async () => {
    const { parseAiPageResponse } =
      await import('../../../packages/pdf-structure/src/ai-read/parse')
    const reading = parseAiPageResponse(
      '<page-content>\n<table><tr><td>Station</td><td>Busan</td></tr></table>\n</page-content>',
      { page: 1, pageFingerprint: '' },
    )
    if (!reading.ok) throw Error('invalid table fixture')
    const items = [1, 4].map((ordinal, index) => ({
      index: index + 1,
      part,
      relId: 'shared',
      location: 'document.xml · ¶' + ordinal,
      text: 'Station Busan',
      form: reading.reading.payload,
    }))
    const result = await JSZip.loadAsync(
      await placeOcrText(await source(), 'docx', items, { kind: 'docx-next-page' }),
    )
    const xml = await result.file(part)!.async('string')
    expect(xml.split(first + '<w:p><w:r><w:br w:type="page"/></w:r></w:p><w:tbl>').length - 1).toBe(
      2,
    )
    expect(xml.match(/>Station<|>Busan</g)).toHaveLength(4)
    expect(xml).toContain(table)
  })
  it('refuses stale picture identity and page breaks in repeating headers', async () => {
    await expect(
      placeOcrText(await source(), 'docx', [{ ...words[0]!, relId: 'gone' }], {
        kind: 'docx-before-images',
      }),
    ).rejects.toThrow(/missing/)
    await expect(
      placeOcrText(
        await source(),
        'docx',
        [
          {
            index: 1,
            text: 'Header',
            part: 'word/header1.xml',
            relId: 'shared',
            location: 'header1.xml · ¶1',
          },
        ],
        { kind: 'docx-next-page' },
      ),
    ).rejects.toThrow(/body/)
  })
  it('relocates a selected anchor in a live copy and keeps other occurrences of its picture untouched', async () => {
    const { placeOcrIntoOpenDocx } = await import('../src/main/translate/ocr-docx-placement')
    const input = await source()
    const selected = {
      index: 1,
      text: 'Selected',
      part,
      relId: 'shared',
      location: 'document.xml · ¶4',
    }
    const out = await placeOcrIntoOpenDocx(input, [selected], { kind: 'docx-next-page' })
    const xml = await (await JSZip.loadAsync(out.bytes)).file(part)!.async('string')
    expect(xml).toContain(table + first + '<w:p><w:r><w:br w:type="page"/></w:r></w:p>')
    expect(xml.match(/>Selected</g)).toHaveLength(1)
    await expect(
      placeOcrIntoOpenDocx(input, [{ ...selected, location: 'document.xml · ¶9' }], {
        kind: 'docx-before-images',
      }),
    ).rejects.toThrow(/no picture/)
  })
})
