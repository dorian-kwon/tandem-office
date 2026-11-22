import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { htmlTablesToXlsxBuffer } from '@genoffice/xlsx-gateway/gateway/html-import'
import { xlsxSidecarPath } from '../../../packages/cli/src/resources'
import { ocrOfficeWorkbook } from '../src/main/ocr-office-workbook'
import { ensurePdfium } from '../src/main/pdf2docx-local'
import { mergedScan } from './fixtures/ocr-merged-scan'
import { readBasicWorkbook } from '@genoffice/xlsx-gateway/gateway/xlsx-gateway'
import { sheetOcrHtml } from '../src/main/ocr-office-sheets'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sheet-ocr-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

it.each([
  ['csv', '항목,"a,b"\r\n값,"한 줄\n두 줄"', '<td>a,b</td>'],
  ['tsv', '항목\ta,b\r\n값\t"한 줄\n두 줄"', '<td>a,b</td>'],
])('keeps quoted fields and in-cell lines in %s', async (ext, body, expected) => {
  const source = join(dir, 'table.' + ext)
  const output = join(dir, 'editable.html')
  await writeFile(source, body)
  await sheetOcrHtml(source, output)
  const html = await readFile(output, 'utf8')
  expect(html).toContain(expected)
  expect(html).toContain('<td>한 줄<br>두 줄</td>')
})

const pkg = 'http://schemas.openxmlformats.org/package/2006/relationships'
const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const drawing = 'http://schemas.openxmlformats.org/drawingml/2006'
const pixel =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV+MAAAAASUVORK5CYII='

async function addScan(zip: JSZip, bytes: Uint8Array) {
  const sheet = 'xl/worksheets/sheet1.xml'
  zip.file(
    sheet,
    (await zip.file(sheet)!.async('string')).replace(
      '</worksheet>',
      `<drawing xmlns:r="${office}" r:id="rId1"/></worksheet>`,
    ),
  )
  const rels = (kind: string, target: string) =>
    `<Relationships xmlns="${pkg}"><Relationship Id="rId1" Type="${office}/${kind}" Target="${target}"/></Relationships>`
  zip.file('xl/worksheets/_rels/sheet1.xml.rels', rels('drawing', '../drawings/drawing1.xml'))
  zip.file(
    'xl/drawings/drawing1.xml',
    `<xdr:wsDr xmlns:xdr="${drawing}/spreadsheetDrawing" xmlns:a="${drawing}/main" xmlns:r="${office}"><xdr:oneCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="400000" cy="400000"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="1" name="picture"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId1"/></xdr:blipFill><xdr:spPr/></xdr:pic><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>`,
  )
  zip.file('xl/drawings/_rels/drawing1.xml.rels', rels('image', '../media/scan.png'))
  zip.file('xl/media/scan.png', bytes)
}

it.skipIf(!xlsxSidecarPath()).each(['xlsx', 'xlsm'])(
  'converts all sheets, a two-way merge and an image anchored in a covered cell from %s',
  async (ext) => {
    const source = join(dir, 'table.' + ext)
    const output = join(dir, 'document.html')
    const zip = await JSZip.loadAsync(
      await htmlTablesToXlsxBuffer([
        {
          name: '표',
          rows: [
            ['제목', '', '셋'],
            ['', '', '끝'],
          ],
          merges: ['A1:B2'],
        },
        { name: '참고', rows: [['다음 <표>']], merges: [] },
      ]),
    )
    const wb = 'xl/workbook.xml'
    zip.file(
      wb,
      (await zip.file(wb)!.async('string')).replace('name="참고"', 'state="hidden" name="참고"'),
    )
    await addScan(zip, Buffer.from(pixel, 'base64'))
    await writeFile(source, await zip.generateAsync({ type: 'nodebuffer' }))
    await sheetOcrHtml(source, output)
    const html = await readFile(output, 'utf8')
    expect(html).toContain(
      '<td rowspan="2" colspan="2">제목<img src="data:image/png;base64,' + pixel + '"></td>',
    )
    expect(html).toContain('<tr><td>끝</td></tr>')
    expect(html).toContain('<h2>참고</h2><table><tr><td>다음 &lt;표&gt;</td></tr></table>')
  },
)

it.each(['replace', 'conflict', 'below', 'below-conflict'])(
  'keeps workbook data and reconstructs a scanned merged table (%s)',
  async (mode) => {
    const source = join(dir, 'layout.xlsm')
    const output = join(dir, 'edited.xlsm')
    const { png, recognized } = mergedScan()
    const zip = await JSZip.loadAsync(
      await htmlTablesToXlsxBuffer([
        {
          name: '양식',
          rows: [
            ['native', '', '', ''],
            ['', mode === 'conflict' ? 'existing' : '', '', 'retain row height'],
            ['', mode === 'below-conflict' ? 'existing' : '', '', ''],
            ['', '', '', ''],
          ],
          merges: [],
        },
        { name: '다른 시트', rows: [['keep']], merges: [] },
      ]),
    )
    await addScan(zip, png)
    if (mode.startsWith('below')) {
      const part = 'xl/worksheets/sheet1.xml'
      const xml = await zip.file(part)!.async('string')
      zip.file(part, xml.replace('<row r="2"', '<row ht="40" customHeight="1" r="2"'))
    }
    if (mode === 'conflict' || mode === 'below-conflict') {
      const address = mode === 'conflict' ? 'B2' : 'B3'
      const path = 'xl/worksheets/sheet1.xml'
      const xml = await zip.file(path)!.async('string')
      zip.file(
        path,
        xml.replace(
          new RegExp('<c r="' + address + '"[^>]*>[\\s\\S]*?</c>'),
          '<c r="' + address + '"><f>1+1</f><v>2</v></c>',
        ),
      )
    }
    const macro = Buffer.from('retain source macro data')
    zip.file('xl/vbaProject.bin', macro)
    const original = await zip.generateAsync({ type: 'nodebuffer' })
    await writeFile(source, original)
    await ocrOfficeWorkbook(
      source,
      output,
      await ensurePdfium(),
      () => ({
        lines: recognized,
        paperShare: 0.98,
      }),
      mode.startsWith('below') ? 'below' : 'replace',
    )
    const generated = await readFile(output)
    const result = await JSZip.loadAsync(generated)
    const { snapshot } = await readBasicWorkbook(generated)
    expect(await readFile(source)).toEqual(original)
    expect(await result.file('xl/vbaProject.bin')!.async('nodebuffer')).toEqual(macro)
    expect(snapshot.sheets[0]!.cells.A1?.value).toBe('native')
    expect(snapshot.sheets[1]!.cells.A1?.value).toBe('keep')
    if (mode === 'replace') {
      expect(snapshot.sheets).toHaveLength(2)
      expect(snapshot.sheets[0]!.cells.B2?.value).toBe('Tour schedule')
      expect(snapshot.sheets[0]!.cells.B3?.value).toBe('Busan')
      expect(snapshot.sheets[0]!.cells.C4?.value).toBe('Tuesday')
      const sheet = await result.file('xl/worksheets/sheet1.xml')!.async('string')
      expect(sheet).toContain('mergeCell ref="B2:C2"')
      expect(sheet).toContain('mergeCell ref="B3:B4"')
      expect((await result.file('xl/drawings/drawing1.xml')?.async('string')) ?? '').not.toContain(
        '<xdr:pic>',
      )
    } else if (mode === 'below') {
      expect(snapshot.sheets).toHaveLength(2)
      expect(snapshot.sheets[0]!.cells.B3?.value).toBe('Tour schedule')
      expect(snapshot.sheets[0]!.cells.C5?.value).toBe('Tuesday')
      expect(await result.file('xl/drawings/drawing1.xml')!.async('string')).toContain('<xdr:pic>')
    } else {
      expect(snapshot.sheets).toHaveLength(3)
      expect(snapshot.sheets[0]!.cells[mode === 'below-conflict' ? 'B3' : 'B2']?.formula).toContain(
        '1+1',
      )
      expect(snapshot.sheets[2]!.cells.A1?.value).toBe('Tour schedule')
      expect(snapshot.sheets[2]!.cells.B3?.value).toBe('Tuesday')
      expect(await result.file('xl/drawings/drawing1.xml')!.async('string')).toContain('<xdr:pic>')
    }
  },
)

it.each(['existing', 'new', 'occupied', 'overflow', 'protected', 'duplicate'])(
  'inserts OCR grids in the selected Excel destination (%s)',
  async (mode) => {
    const source = join(dir, 'chosen.xlsm'),
      output = join(dir, 'chosen-result.xlsm')
    const { png, recognized } = mergedScan()
    const zip = await JSZip.loadAsync(
      await htmlTablesToXlsxBuffer([
        { name: 'Source', rows: [['scan']], merges: [] },
        { name: 'Destination', rows: [['existing'], [''], ['']], merges: [] },
      ]),
    )
    await addScan(zip, png)
    const drawingPath = 'xl/drawings/drawing1.xml'
    const drawing = await zip.file(drawingPath)!.async('string')
    const anchor = drawing.match(/<xdr:oneCellAnchor>[\s\S]*?<\/xdr:oneCellAnchor>/)![0]
    zip.file(
      drawingPath,
      drawing.replace(
        '</xdr:wsDr>',
        anchor.replace('id="1" name="picture"', 'id="2" name="copy"') + '</xdr:wsDr>',
      ),
    )
    const part = 'xl/worksheets/sheet2.xml'
    const xml = await zip.file(part)!.async('string')
    if (mode === 'protected')
      zip.file(part, xml.replace('</worksheet>', '<sheetProtection sheet="1"/></worksheet>'))
    if (mode === 'occupied')
      zip.file(
        part,
        xml.replace(
          '</sheetData>',
          '<row r="5"><c r="E5"><f>1+1</f><v>2</v></c></row></sheetData>',
        ),
      )
    zip.file('xl/vbaProject.bin', Buffer.from('macro fixture'))
    const input = await zip.generateAsync({ type: 'nodebuffer' })
    await writeFile(source, input)
    const destination =
      mode === 'new' || mode === 'duplicate'
        ? { kind: 'xlsx-new-sheet' as const, sheet: mode === 'new' ? 'New OCR' : 'destination' }
        : {
            kind: 'xlsx-cells' as const,
            sheet: 'Destination',
            cell: mode === 'overflow' ? 'XFD1048576' : 'D4',
            overwrite: false as const,
          }
    let calls = 0
    const run = ocrOfficeWorkbook(
      source,
      output,
      await ensurePdfium(),
      () => {
        calls++
        return { lines: recognized, paperShare: 0.98 }
      },
      'below',
      destination,
    )
    if (!['existing', 'new'].includes(mode)) {
      await expect(run).rejects.toThrow(
        {
          occupied: 'OCR_SHEET_DESTINATION_OCCUPIED',
          overflow: 'OCR_SHEET_GRID_LIMIT',
          protected: 'OCR_SHEET_PROTECTED',
          duplicate: 'OCR_SHEET_NAME_USED',
        }[mode],
      )
      if (mode === 'protected' || mode === 'duplicate') expect(calls).toBe(0)
      await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' })
    } else {
      await run
      expect(calls).toBe(1)
      const bytes = await readFile(output)
      const saved = await JSZip.loadAsync(bytes)
      const { snapshot } = await readBasicWorkbook(bytes)
      const target = snapshot.sheets.find((s) => s.name === destination.sheet)!
      expect(target.cells[mode === 'new' ? 'A1' : 'D4']?.value).toBe('Tour schedule')
      expect(target.cells[mode === 'new' ? 'A5' : 'D8']?.value).toBe('Tour schedule')
      expect(
        await saved
          .file('xl/worksheets/sheet' + (mode === 'new' ? '3' : '2') + '.xml')!
          .async('string'),
      ).toContain('mergeCell ref="' + (mode === 'new' ? 'A1:B1' : 'D4:E4') + '"')
      expect(await saved.file(drawingPath)!.async('string')).toBe(
        await zip.file(drawingPath)!.async('string'),
      )
      expect(await saved.file('xl/vbaProject.bin')!.async('string')).toBe('macro fixture')
      expect(snapshot.sheets[1]!.cells.A1?.value).toBe('existing')
    }
    expect(await readFile(source)).toEqual(input)
  },
)
