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
