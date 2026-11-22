import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseAiPageResponse } from '../../../packages/pdf-structure/src/ai-read/parse'
import { randomUUID } from 'node:crypto'
import JSZip from 'jszip'
import { htmlTablesToXlsxBuffer } from '@genoffice/xlsx-gateway/gateway/html-import'
import { buildDocx, TINY_PNG_BASE64 } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { addSource, createProject } from '@genoffice/translate-project'
import { runEditorOcrInsert } from '../src/main/editor-ocr-insert'
import type { OcrChatPopup } from '../src/main/translate/ocr-chat'
import { createOcrService } from '../src/main/translate/ocr'
import { allowAdHocDir, isAdHocDir } from '../src/main/translate/adhoc-dirs'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'editor-popup-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function fixture(label: string) {
  return buildDocx({
    bodyXml:
      '<w:p><w:r><w:t>' +
      label +
      '</w:t></w:r></w:p><w:p><w:r><w:drawing><a:blip r:embed="rScan"/></w:drawing></w:r></w:p>' +
      '<w:tbl><w:tr><w:tc><w:p/><w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl><w:p/></w:tc></w:tr></w:tbl>',
    extraRels:
      '<Relationship Id="rScan" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/scan.png"/>',
    binaryParts: [
      {
        path: 'word/media/scan.png',
        base64: TINY_PNG_BASE64,
        extension: 'png',
        contentType: 'image/png',
      },
    ],
  })
}

function options(path: string, ask: OcrChatPopup['ask']) {
  const ocr = createOcrService(
    {
      pdfPageCount: async () => 1,
      renderPdfPage: vi.fn(async (): Promise<Uint8Array> => {
        throw Error('should reuse confirmed reading')
      }),
      markdownToDocx: async (markdown) =>
        buildDocx({ bodyXml: '<w:p><w:r><w:t>' + markdown.trim() + '</w:t></w:r></w:p>' }),
    },
    Date.now,
    randomUUID,
  )
  return {
    path,
    outputDir: dir,
    ownerId: 17,
    readOnly: false,
    apply: true,
    current: async () => true,
    workDir: () => join(dir, 'private'),
    ocrMode: () => ({ kind: 'ai', provider: 'claude' }) as const,
    ocr,
    popup: { ask },
    signal: new AbortController().signal,
  }
}

it('puts a selected picture reading in the chosen nested cell of the open working copy', async () => {
  const source = join(dir, 'report.docx')
  await writeFile(source, await fixture('Original source'))
  const project = await createProject(dir, 'actual-project', 'ko', 'en')
  await addSource(project.dir, source)
  const working = join(project.dir, 'output', 'report.docx')
  const workingBytes = await fixture('Translated working document')
  await writeFile(working, workingBytes)
  let workspace = ''
  const opts = options(working, async (id, target) => {
    expect(id).toBe(17)
    expect(target.purpose).toBe('editor')
    expect(target.dir).not.toBe(project.dir)
    workspace = target.dir
    allowAdHocDir(workspace)
    expect(await readFile(join(workspace, 'source', target.file))).toEqual(
      Buffer.from(workingBytes),
    )
    return {
      kind: 'result',
      result: {
        pages: [{ index: 1, location: '', text: 'Cell reading' }],
        placement: { kind: 'docx-table-cell', table: 2, row: 1, column: 1, overwrite: false },
      },
    }
  })
  expect(await runEditorOcrInsert(opts)).toEqual({ outputPath: working })
  const archive = await JSZip.loadAsync(await readFile(working))
  const body = await archive.file('word/document.xml')!.async('string')
  expect(body).toContain('Translated working document')
  expect(body).toMatch(/<w:tbl><w:tr><w:tc><w:p\/><w:tbl>[\s\S]*?Cell reading[\s\S]*?<\/w:tbl>/)
  expect(body).toContain('r:embed="rScan"')
  expect(await readFile(join(project.dir, 'output', 'report (before OCR).docx'))).toEqual(
    Buffer.from(workingBytes),
  )
  expect(await readFile(join(project.dir, 'source', 'report.docx'))).toEqual(await readFile(source))
  expect(await readdir(opts.workDir())).toEqual([])
  expect(isAdHocDir(workspace)).toBe(false)
})

it.each([true, false])(
  'uses the chosen destination and writes OCR with formatting %s',
  async (keepFormatting) => {
    const path = join(dir, 'table.docx')
    await writeFile(path, await fixture('Working'))
    const reading = parseAiPageResponse(
      '<page-content>\n<table><tr><th colspan="2">Report</th></tr><tr><td>Busan</td><td>23</td></tr></table>\n</page-content>',
      { page: 1, pageFingerprint: '' },
    )
    if (!reading.ok) throw Error('Invalid fixture')
    const placement = { kind: 'docx-replace-images' } as const
    const opts = options(path, async (_, target) => {
      expect(target.placement).toEqual(placement)
      return {
        kind: 'result',
        result: {
          placement: { kind: 'docx-end' },
          pages: [
            { index: 1, location: '', text: 'Report Busan 23', form: reading.reading.payload },
          ],
        },
      }
    })
    const output = await runEditorOcrInsert({ ...opts, apply: false, keepFormatting, placement })
    const archive = await JSZip.loadAsync(await readFile(output!.outputPath))
    const xml = await archive.file('word/document.xml')!.async('string')
    expect(xml).not.toContain('r:embed="rScan"')
    expect(xml).toContain('Busan')
    expect(xml.match(/<w:tbl>/g)).toHaveLength(keepFormatting ? 3 : 2)
    expect(xml.includes('<w:gridSpan w:val="2"/>')).toBe(keepFormatting)
  },
)

it('only transfers the chosen Excel picture into editable merged cells', async () => {
  const path = join(dir, 'two-pictures.xlsx')
  const source = await JSZip.loadAsync(
    await htmlTablesToXlsxBuffer([{ name: 'Source', rows: [['Original']], merges: [] }]),
  )
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  const rels = (body: string) =>
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    body +
    '</Relationships>'
  const sheet = 'xl/worksheets/sheet1.xml'
  source.file(
    sheet,
    (await source.file(sheet)!.async('string')).replace(
      '</worksheet>',
      '<drawing xmlns:r="' + rel + '" r:id="drawing"/></worksheet>',
    ),
  )
  source.file(
    'xl/worksheets/_rels/sheet1.xml.rels',
    rels(
      '<Relationship Id="drawing" Type="' + rel + '/drawing" Target="../drawings/drawing1.xml"/>',
    ),
  )
  const ids = [1, 2]
  const drawing = 'http://schemas.openxmlformats.org/drawingml/2006'
  source.file(
    'xl/drawings/drawing1.xml',
    '<xdr:wsDr xmlns:xdr="' +
      drawing +
      '/spreadsheetDrawing" xmlns:a="' +
      drawing +
      '/main" xmlns:r="' +
      rel +
      '">' +
      ids
        .map(
          (id) =>
            '<xdr:oneCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:row>' +
            id +
            '</xdr:row></xdr:from><xdr:pic><a:blip r:embed="p' +
            id +
            '"/></xdr:pic></xdr:oneCellAnchor>',
        )
        .join('') +
      '</xdr:wsDr>',
  )
  source.file(
    'xl/drawings/_rels/drawing1.xml.rels',
    rels(
      ids
        .map(
          (id) =>
            '<Relationship Id="p' +
            id +
            '" Type="' +
            rel +
            '/image" Target="../media/scan' +
            id +
            '.png"/>',
        )
        .join(''),
    ),
  )
  for (const id of ids)
    source.file('xl/media/scan' + id + '.png', Buffer.from(TINY_PNG_BASE64, 'base64'))
  await writeFile(path, await source.generateAsync({ type: 'nodebuffer' }))
  const form = parseAiPageResponse(
    '<page-content>\n<table><tr><th colspan="2">Second picture</th></tr><tr><td>B</td><td>42</td></tr></table>\n</page-content>',
    { page: 2, pageFingerprint: '' },
  )
  if (!form.ok) throw Error('Invalid fixture')
  const placement = { kind: 'xlsx-new-sheet', sheet: 'Result' } as const
  const opts = options(path, async () => ({
    kind: 'result',
    result: {
      placement,
      pages: [{ index: 2, location: '', text: 'Second picture B 42', form: form.reading.payload }],
    },
  }))
  const start = vi.spyOn(opts.ocr, 'start')
  const output = await runEditorOcrInsert({
    ...opts,
    apply: false,
    keepFormatting: true,
    placement,
  })
  expect(start).toHaveBeenCalledWith(expect.any(String), [2])
  const zip = await JSZip.loadAsync(await readFile(output!.outputPath))
  const xml = await zip.file('xl/worksheets/sheet2.xml')!.async('string')
  expect(xml).toContain('A1:B1')
  expect(xml).toContain('Second picture')
  expect(xml).toContain('42')
  expect(await zip.file(sheet)!.async('string')).toEqual(await source.file(sheet)!.async('string'))
  for (const id of ids)
    expect(await zip.file('xl/media/scan' + id + '.png')!.async('base64')).toBe(TINY_PNG_BASE64)
})

it('cancels cleanly and rejects an intervening change without starting a write', async () => {
  const path = join(dir, 'scan.docx')
  await writeFile(path, await fixture('initial'))
  const opts = options(path, async () => ({ kind: 'closed' }))
  expect(await runEditorOcrInsert(opts)).toBeNull()
  expect(await readdir(opts.workDir())).toEqual([])
  const changed = options(path, async () => {
    await writeFile(path, 'another edit')
    return {
      kind: 'result',
      result: {
        placement: { kind: 'docx-end' },
        pages: [{ index: 1, location: '', text: 'reading' }],
      },
    }
  })
  await expect(runEditorOcrInsert(changed)).rejects.toThrow('OCR_DOCUMENT_CHANGED')
  expect(await readFile(path, 'utf8')).toBe('another edit')
  expect(await readdir(dir)).toEqual(expect.arrayContaining(['scan.docx', 'private']))
  expect(
    (await readdir(dir)).some((n) => n.includes('before OCR') || n.startsWith('.convert')),
  ).toBe(false)
})

it('publishes a page reading under the original file name when a prepared PDF was used', async () => {
  const originalPath = join(dir, '슬라이드.pptx')
  await writeFile(originalPath, 'original presentation')
  await mkdir(join(dir, 'stage'))
  const pdf = join(dir, 'stage', 'render.pdf')
  await writeFile(pdf, '%PDF-1.5')
  const opts = options(pdf, async () => ({
    kind: 'result',
    result: {
      newDocument: true,
      pages: [{ index: 1, location: '', text: 'Slide transcription' }],
    },
  }))
  const result = await runEditorOcrInsert({ ...opts, originalPath, readOnly: true, apply: false })
  expect(result?.outputPath).toBe(join(dir, '슬라이드 (OCR).docx'))
  expect(await readFile(originalPath, 'utf8')).toBe('original presentation')
  const bytes = await JSZip.loadAsync(await readFile(result!.outputPath))
  expect(await bytes.file('word/document.xml')!.async('string')).toContain('Slide transcription')
  expect(await readdir(opts.workDir())).toEqual([])
})

it.each(['hwp', 'hwpx'])(
  'reads only the selected nested picture from an open %s file',
  async (ext) => {
    const original = await readFile(join(__dirname, 'fixtures', 'ocr-nested-tables.' + ext))
    const path = join(dir, '서식.' + ext)
    await writeFile(path, original)
    const opts = options(path, async () => ({
      kind: 'result',
      result: { newDocument: true, pages: [{ index: 1, location: '', text: '안쪽 표의 그림' }] },
    }))
    const selection = vi.spyOn(opts.ocr, 'start')
    const result = await runEditorOcrInsert({ ...opts, apply: false })
    expect(selection).toHaveBeenCalledWith(expect.any(String), [1])
    expect(result?.outputPath).toBe(join(dir, '서식 (OCR).docx'))
    expect(await readFile(path)).toEqual(original)
    expect(await readdir(opts.workDir())).toEqual([])
  },
)
