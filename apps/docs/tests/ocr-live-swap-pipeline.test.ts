import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listEmbeddedImages,
  readEmbeddedImage,
} from '../../shell/src/main/translate/embedded-images'
import { recommendOcrPlacement } from '../../shell/src/main/translate/ocr-recommendation'
import { placeOcrIntoOpenDocx } from '../../shell/src/main/translate/ocr-docx-placement'
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import JSZip from 'jszip'
import { parseDocx, saveDocx } from '@genoffice/docx-engine'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { placeOcrText } from '../../shell/src/main/translate/ocr-placement'
import { blocksToPmDoc, pmDocToSavePlan, type PmNode } from '../src/renderer/editor/convert'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { readRunGroups } from '../src/renderer/ai/translate-runs'

/**
 * The steps of putting OCR boxes into the document that is open: the editor's current bytes (with
 * an edit that was never saved), the boxes put into those bytes, the result read back into the
 * editor. Only existing functions are used: this shows the pieces fit before anything new is built.
 */

const picture =
  '<w:r><w:drawing><wp:inline><wp:extent cx="3000000" cy="1500000"/><wp:docPr id="7" name="P"/>' +
  '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
  '<pic:pic><pic:blipFill><a:blip r:embed="rId10"/></pic:blipFill></pic:pic></a:graphicData>' +
  '</a:graphic></wp:inline></w:drawing></w:r>'

const live: Editor[] = []
afterEach(() => live.splice(0).forEach((e) => e.destroy()))
const editorFor = (parsed: Awaited<ReturnType<typeof parseDocx>>) => {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: blocksToPmDoc(parsed.blocks) as never,
  })
  live.push(editor)
  return editor
}
const wt = (xml: string) => [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1])

describe('boxes into the document that is open', () => {
  it('keeps an unsaved edit, adds the boxes, and saves both under the same pictures', async () => {
    const source = await buildDocx({
      withImage: true,
      bodyXml:
        '<w:p><w:r><w:t>Intro</w:t></w:r></w:p>' +
        '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="6000"/></w:tblGrid><w:tr><w:tc>' +
        `<w:p>${picture}</w:p></w:tc></w:tr></w:tbl><w:p/>`,
    })

    // 1. the open document, with an edit that has not been saved
    const parsed = await parseDocx(source)
    const editor = editorFor(parsed)
    editor.chain().focus('start').insertContent('EDITED ').run()
    const plan = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
    const liveBytes = await saveDocx(parsed, plan.saveBlocks)
    expect(
      wt(await (await JSZip.loadAsync(liveBytes)).file('word/document.xml')!.async('string')),
    ).toContain('EDITED Intro')

    // 2. the boxes into those bytes, by the picture's relationship id
    const boxes = [
      { x: 0.1, y: 0.2, w: 0.3, h: 0.1, fontHeight: 0.08, text: 'Shop name' },
      { x: 0.5, y: 0.6, w: 0.3, h: 0.1, fontHeight: 0.08, text: 'Opening hours' },
    ]
    const placed = await placeOcrText(
      liveBytes,
      'docx',
      [
        {
          index: 1,
          text: 'Shop name\nOpening hours',
          location: 'document.xml · ¶2',
          part: 'word/document.xml',
          relId: 'rId10',
        },
      ],
      { kind: 'docx-image-boxes', images: [{ index: 1, boxes }] },
    )

    // 3. read back into the editor
    const reparsed = await parseDocx(placed)
    const swapped = editorFor(reparsed)
    expect(swapped.state.doc.textContent).toContain('EDITED Intro')
    const entries = readRunGroups(swapped, 0, swapped.state.doc.childCount - 1).filter(
      (e) => e.box !== undefined,
    )
    expect(entries.map((e) => e.segments)).toEqual([['Shop name'], ['Opening hours']])

    // saved again, the edit, the boxes and the picture are all there
    const resaved = await saveDocx(
      reparsed,
      pmDocToSavePlan(swapped.getJSON() as PmNode, reparsed.blocks).saveBlocks,
    )
    const xml = await (await JSZip.loadAsync(resaved)).file('word/document.xml')!.async('string')
    expect(wt(xml)).toEqual(expect.arrayContaining(['EDITED Intro', 'Shop name', 'Opening hours']))
    expect(xml).toContain('r:embed="rId10"')
  })
})

it('lists the selected inner-cell image and places its reading in that table after a live edit', async () => {
  const p = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`
  const cell = (contents: string) => `<w:tc>${contents}</w:tc>`
  const table = (...cells: string[]) =>
    `<w:tbl><w:tblPr/><w:tblGrid>${cells.map(() => '<w:gridCol w:w="3000"/>').join('')}</w:tblGrid><w:tr>${cells.map(cell).join('')}</w:tr></w:tbl>`
  const inner = table(
    p('Inner marker') +
      '<w:p>' +
      picture.replace('rId10', 'rId11').replace('id="7"', 'id="8"') +
      '</w:p>',
    '<w:p/>',
  )
  const secondRow = '<w:tr>' + cell('<w:p/>') + cell('<w:p/>') + '</w:tr>'
  const outer = table(
    p('Outer marker') + inner.replace('</w:tbl>', secondRow + '</w:tbl>') + '<w:p/>',
    '<w:p/>',
  )
  const image2 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh1sAAAAASUVORK5CYII='
  const source = await buildDocx({
    withImage: true,
    extraRels:
      '<Relationship Id="rId11" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image2.png"/>',
    binaryParts: [
      { path: 'word/media/image2.png', extension: 'png', contentType: 'image/png', base64: image2 },
    ],
    bodyXml: p('Intro') + '<w:p>' + picture + '</w:p>' + outer + '<w:p/>',
  })
  const dir = await mkdtemp(join(tmpdir(), 'tandem-docx-nested-ocr-'))
  try {
    const path = join(dir, 'nested.docx')
    await writeFile(path, source)
    const images = await listEmbeddedImages(path)
    expect(images.map((i) => [i.relId, i.location])).toEqual([
      ['rId10', 'document.xml · ¶2'],
      ['rId11', 'document.xml · ¶5'],
    ])
    const selected = images[1]!
    expect(Buffer.from((await readEmbeddedImage(path, selected)).data).toString('base64')).toBe(
      image2,
    )
    const item = {
      index: 2,
      part: selected.part,
      relId: selected.relId,
      location: selected.location,
      text: 'Inner reading',
    }
    const mixed = await recommendOcrPlacement(source, 'docx', [item, images[0]!])
    expect(mixed.placement).toEqual({ kind: 'docx-after-images' })
    const recommendation = await recommendOcrPlacement(source, 'docx', [item])
    expect(recommendation.placement).toEqual({
      kind: 'docx-table-cell',
      table: 2,
      row: 1,
      column: 2,
      overwrite: false,
    })
    const rendered = async (bytes: Uint8Array) => {
      const zip = await JSZip.loadAsync(bytes)
      const raw = await zip.file('word/document.xml')!.async('string')
      const xml = new DOMParser().parseFromString(raw, 'application/xml')
      const tables = Array.from(xml.getElementsByTagName('w:tbl'))
      expect(tables).toHaveLength(2)
      const cells = (table: Element) =>
        Array.from(Array.from(table.children).find((e) => e.localName === 'tr')!.children).filter(
          (e) => e.localName === 'tc',
        )
      expect(cells(tables[0]!)[1]?.textContent).toBe('')
      expect(xml.getElementsByTagName('a:blip')).toHaveLength(2)
      expect(await zip.file('word/media/image2.png')!.async('base64')).toBe(image2)
      return { inner: cells(tables[1]!).map((c) => c.textContent), raw }
    }
    const dst = await placeOcrText(source, 'docx', [item], recommendation.placement)
    expect((await rendered(dst)).inner).toEqual(['Inner marker', 'Inner reading'])
    expect((await recommendOcrPlacement(dst, 'docx', [item])).placement).toEqual({
      kind: 'docx-after-images',
    })
    expect(selected.boxable).toBe(true)
    const overlay = await placeOcrText(source, 'docx', [item], {
      kind: 'docx-image-boxes',
      images: [
        {
          index: 2,
          boxes: [{ x: 0.1, y: 0.2, w: 0.4, h: 0.2, fontHeight: 0.03, text: 'Inner box' }],
        },
      ],
    })
    const overlayXml = await rendered(overlay)
    expect(overlayXml.inner[0]).toContain('Inner box')
    expect(overlayXml.inner[1]).toBe('')
    expect(overlayXml.raw).toContain('<wp:anchor')
    const after = await placeOcrText(source, 'docx', [item], { kind: 'docx-after-images' })
    expect((await rendered(after)).inner).toEqual(['Inner markerInner reading', ''])
    const parsed = await parseDocx(source)
    const editor = editorFor(parsed)
    editor.commands.insertContentAt(0, {
      type: 'docParagraph',
      content: [{ type: 'text', text: 'Unsaved first paragraph' }],
    })
    const liveBytes = await saveDocx(
      parsed,
      pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks).saveBlocks,
    )
    const placed = await placeOcrIntoOpenDocx(liveBytes, [item], { kind: 'docx-after-images' })
    expect([placed.placed, placed.skipped]).toEqual([[2], []])
    const reopened = await parseDocx(placed.bytes)
    const swapped = editorFor(reopened)
    const resaved = await saveDocx(
      reopened,
      pmDocToSavePlan(swapped.getJSON() as PmNode, reopened.blocks).saveBlocks,
    )
    const liveResult = await rendered(resaved)
    expect(liveResult.raw).toContain('Unsaved first paragraph')
    expect(liveResult.inner).toEqual(['Inner markerInner reading', ''])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
