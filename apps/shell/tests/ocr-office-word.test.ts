import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { parseDocx } from '@genoffice/docx-engine'
import { Editor } from '@tiptap/core'
import { blocksToPmDoc } from '../../docs/src/renderer/editor/convert'
import { editorExtensions } from '../../docs/src/renderer/editor/extensions'
import { readRunGroups } from '../../docs/src/renderer/ai/translate-runs'
import { mergedScan } from './fixtures/ocr-merged-scan'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { PdfiumModule } from '../../../packages/pdf2docx/src'
import { convertOcrFile } from '../src/main/ocr-file'
import { ocrOfficeWord } from '../src/main/ocr-office-word'
import { ensurePdfium } from '../src/main/pdf2docx-local'

const pngFile = fileURLToPath(
  new URL('../../../packages/pdf2docx/ocr-helper/fixtures/smoke-en.png', import.meta.url),
)
const ns = 'http://schemas.openxmlformats.org'
const xmlns =
  'xmlns:w="' +
  ns +
  '/wordprocessingml/2006/main" xmlns:r="' +
  ns +
  '/officeDocument/2006/relationships" xmlns:a="' +
  ns +
  '/drawingml/2006/main"'
const rel = (id: string, kind: string, target: string) =>
  '<Relationship Id="' +
  id +
  '" Type="' +
  ns +
  '/officeDocument/2006/relationships/' +
  kind +
  '" Target="' +
  target +
  '"/>'
const rels = (nodes: string) =>
  '<Relationships xmlns="' + ns + '/package/2006/relationships">' + nodes + '</Relationships>'
const picture = (id: string) =>
  '<w:p><w:r><w:drawing><a:blip r:embed="' + id + '"/></w:drawing></w:r></w:p>'
const paragraph = '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Original text</w:t></w:r></w:p>'
let dir: string, module: PdfiumModule
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'office-ocr-word-'))
  module = await ensurePdfium()
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function readForTranslation(path: string) {
  const parsed = await parseDocx(await readFile(path))
  const editor = new Editor({
    element: null,
    extensions: editorExtensions,
    content: blocksToPmDoc(parsed.blocks, parsed.sections),
  })
  try {
    return readRunGroups(editor, 0, editor.state.doc.childCount - 1)
  } finally {
    editor.destroy()
  }
}

async function document(name: string, body: string, hasHeader = false): Promise<string> {
  const zip = new JSZip()
  zip.file(
    'word/document.xml',
    '<w:document ' + xmlns + '><w:body>' + body + '<w:sectPr/></w:body></w:document>',
  )
  zip.file('word/media/scan.png', await readFile(pngFile))
  zip.file(
    'word/_rels/document.xml.rels',
    rels(
      rel('scan', 'image', 'media/scan.png') + (hasHeader ? rel('h', 'header', 'header3.xml') : ''),
    ),
  )
  if (hasHeader) {
    zip.file('word/header3.xml', '<w:hdr ' + xmlns + '>' + picture('headerScan') + '</w:hdr>')
    zip.file('word/_rels/header3.xml.rels', rels(rel('headerScan', 'image', 'media/scan.png')))
  }
  const path = join(dir, name)
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }))
  return path
}

it('keeps an editable document byte for byte and ignores unreferenced media', async () => {
  const path = await document('native.docx', paragraph)
  const output = join(dir, 'native-output.docx')
  const engine = vi.fn(() => null)
  await ocrOfficeWord(path, output, module, engine)
  expect(engine).not.toHaveBeenCalled()
  expect(await readFile(output)).toEqual(await readFile(path))
})

it('recognizes a shared resource only once and places its editable result at each nested or header occurrence', async () => {
  const cell =
    '<w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>' + paragraph + picture('scan') + '</w:tc>'
  const table = '<w:tbl><w:tr>' + cell + '</w:tr></w:tbl>'
  const path = await document(
    'pictures.docx',
    '<w:tbl><w:tr><w:tc>' + table + '<w:p/></w:tc></w:tr></w:tbl>' + picture('scan'),
    true,
  )
  const output = join(dir, 'pictures-output.docx')
  const engine = vi.fn(() => ({
    lines: [
      {
        text: 'Recognized & editable',
        confidence: 0.98,
        box: { x0: 0.1, y0: 0.65, x1: 0.8, y1: 0.82 },
      },
    ],
    paperShare: 0.96,
  }))
  await ocrOfficeWord(path, output, module, engine)
  expect(engine).toHaveBeenCalledTimes(1)
  const zip = await JSZip.loadAsync(await readFile(output))
  const xml = await zip.file('word/document.xml')!.async('string')
  expect(xml.match(/Recognized &amp; editable/g)).toHaveLength(2)
  expect(xml).toContain(
    '<w:gridSpan w:val="2"/></w:tcPr>' + paragraph + picture('scan') + '<w:sdt>',
  )
  expect(await zip.file('word/header3.xml')!.async('string')).toContain('Recognized &amp; editable')
  expect(await zip.file('word/media/scan.png')!.async('nodebuffer')).toEqual(
    await readFile(pngFile),
  )
  const readable = await readForTranslation(output)
  const matches = readable.filter((entry) => entry.segments?.join('') === 'Recognized & editable')
  expect(matches.map((entry) => entry.nestedTable)).toEqual([0, undefined])
  const second = join(dir, 'second-pass.docx')
  await ocrOfficeWord(output, second, module, engine)
  expect(engine).toHaveBeenCalledTimes(1)
  expect(await readFile(second)).toEqual(await readFile(output))
})

it('reports image-only inputs where recognition yielded no text without producing an empty output', async () => {
  const path = await document('unreadable.docx', picture('scan'))
  const output = join(dir, 'unreadable-output.docx')
  await expect(ocrOfficeWord(path, output, module, () => ({ lines: [] }))).rejects.toThrow(
    'OCR_NO_TEXT',
  )
  await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rebuilds horizontal and vertical merges of a scan as editable cells inside an existing cell', async () => {
  const { png, recognized } = mergedScan()
  const path = await document(
    'merged.docx',
    '<w:tbl><w:tr><w:tc>' + picture('scan') + '</w:tc></w:tr></w:tbl>',
  )
  const zip = await JSZip.loadAsync(await readFile(path))
  zip.file('word/media/scan.png', png)
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }))
  const output = join(dir, 'merged-output.docx')
  await ocrOfficeWord(path, output, module, () => ({ lines: recognized, paperShare: 0.98 }))
  const xml = await (
    await JSZip.loadAsync(await readFile(output))
  )
    .file('word/document.xml')!
    .async('string')
  expect(xml).toContain('<w:tc>' + picture('scan') + '<w:sdt>')
  expect(xml).toContain('<w:sdtContent><w:tbl>')
  expect(xml).toContain('<w:gridSpan w:val="2"/>')
  expect(xml).toContain('<w:vMerge w:val="restart"/>')
  expect(xml).toContain('<w:vMerge w:val="continue"/>')
  for (const { text: word } of recognized) expect(xml).toContain('>' + word + '</w:t>')
  const nested = (await readForTranslation(output)).filter((entry) => entry.nestedTable === 0)
  expect(nested.flatMap((entry) => entry.segments ?? [])).toEqual(
    recognized.map(({ text }) => text),
  )
  const replaced = join(dir, 'merged-replaced.docx')
  await ocrOfficeWord(path, replaced, module, () => ({ lines: recognized, paperShare: 0.98 }), true)
  const replacedXml = await (
    await JSZip.loadAsync(await readFile(replaced))
  )
    .file('word/document.xml')!
    .async('string')
  expect(replacedXml).not.toContain('<w:drawing>')
  expect(replacedXml).toContain('<w:tc><w:tbl>')
  expect(replacedXml).toContain('</w:tbl><w:p/></w:tc>')
  expect(replacedXml).toContain('<w:gridSpan w:val="2"/>')
  expect(replacedXml).toContain('<w:vMerge w:val="restart"/>')
  expect(replacedXml).toContain('<w:vMerge w:val="continue"/>')
  const editable = (await readForTranslation(replaced)).filter((entry) => entry.nestedTable === 0)
  expect(editable.flatMap((entry) => entry.segments ?? [])).toEqual(
    recognized.map(({ text }) => text),
  )
})

it('replaces an inline scan in reading order without disturbing its styling, other drawings or the input', async () => {
  const scan = '<w:drawing><a:blip r:embed="scan"/></w:drawing>'
  const decorative = '<w:drawing><a:blip r:embed="icon"/></w:drawing>'
  const body =
    '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Before</w:t>' +
    scan +
    '<w:t>After</w:t>' +
    decorative +
    '</w:r></w:p>'
  const path = await document('mixed.docx', body, true)
  const zip = await JSZip.loadAsync(await readFile(path))
  zip.file('word/media/icon.emf', new Uint8Array([1, 2]))
  zip.file(
    'word/_rels/document.xml.rels',
    rels(
      rel('scan', 'image', 'media/scan.png') +
        rel('icon', 'image', 'media/icon.emf') +
        rel('h', 'header', 'header3.xml'),
    ),
  )
  const original = await zip.generateAsync({ type: 'nodebuffer' })
  await writeFile(path, original)
  const output = join(dir, 'mixed-result.docx')
  const engine = vi.fn(() => ({
    lines: [{ text: 'Recovered', confidence: 0.99, box: { x0: 0.1, y0: 0.6, x1: 0.8, y1: 0.8 } }],
    paperShare: 0.98,
  }))
  await ocrOfficeWord(path, output, module, engine, true)
  const result = await JSZip.loadAsync(await readFile(output))
  const xml = await result.file('word/document.xml')!.async('string')
  expect(xml).not.toContain(scan)
  expect(xml).toContain(
    '<w:rPr><w:b/></w:rPr><w:t>Before</w:t><w:t xml:space="preserve">Recovered</w:t>',
  )
  expect(xml).toContain('<w:t>After</w:t>' + decorative)
  // The fake OCR boxes leave real ink outside their bounds; that residual artwork is still embedded.
  const art = Object.keys(result.files).find((name) =>
    name.startsWith('word/media/tandem-ocr-art-'),
  )
  expect(art).toBeDefined()
  expect(await result.file('word/_rels/document.xml.rels')!.async('string')).toContain(
    art!.replace('word/', ''),
  )

  expect(await result.file('word/header3.xml')!.async('string')).toContain('Recovered')
  expect(await result.file('word/header3.xml')!.async('string')).not.toContain('<w:drawing>')
  expect(engine).toHaveBeenCalledTimes(1)
  expect(await readFile(path)).toEqual(original)
  const second = join(dir, 'mixed-again.docx')
  await ocrOfficeWord(output, second, module, engine, true)
  expect(await readFile(second)).toEqual(await readFile(output))
})

it('retains user edits to an existing OCR block when replacing the corresponding scan', async () => {
  const source = await document('annotated-source.docx', paragraph + picture('scan'))
  const annotated = join(dir, 'annotated.docx')
  const engine = () => ({
    lines: [
      { text: 'First result', confidence: 0.98, box: { x0: 0.1, y0: 0.6, x1: 0.8, y1: 0.8 } },
    ],
    paperShare: 0.98,
  })
  await ocrOfficeWord(source, annotated, module, engine)
  const edited = await JSZip.loadAsync(await readFile(annotated))
  const part = 'word/document.xml'
  edited.file(
    part,
    (await edited.file(part)!.async('string')).replace('First result', 'Corrected by editor'),
  )
  await writeFile(annotated, await edited.generateAsync({ type: 'nodebuffer' }))
  const below = join(dir, 'edited-existing-below.docx')
  const skip = vi.fn(() => {
    throw new Error('Existing result should be reused')
  })
  await convertOcrFile(annotated, 'docx', below, module, skip, undefined, true, 'below')
  expect(await readFile(below)).toEqual(await readFile(annotated))
  expect(skip).not.toHaveBeenCalled()
  const final = join(dir, 'edited-and-replaced.docx')
  await convertOcrFile(annotated, 'docx', final, module, engine, undefined, false, 'replace')
  const xml = await (await JSZip.loadAsync(await readFile(final))).file(part)!.async('string')
  expect(xml).not.toContain('r:embed="scan"')
  expect(xml).not.toContain('First result')
  expect(xml.match(/Corrected by editor/g)).toHaveLength(1)
  expect(xml).toContain(paragraph)
})
