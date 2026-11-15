import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import JSZip from 'jszip'
import { buildAnchoredTextboxParagraphXml, parseDocx, saveDocx } from '@genoffice/docx-engine'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { blocksToPmDoc, pmDocToSavePlan, type PmNode } from '../src/renderer/editor/convert'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { applyRunTranslations, readRunGroups } from '../src/renderer/ai/translate-runs'
import { estimateTextEm } from '../../shell/src/shared/ocr-boxes'

/**
 * Translating the text of a box that has a fixed size makes the text smaller when the translation
 * would not fit: it is longer than the original, and the box clips what runs past it. The size
 * is never made larger, and a box that grows with its text is left alone.
 */

// a label box like the ones OCR puts over a picture: 57 x 49 points, 20 point lettering
const WIDTH_EMU = 720947
const HEIGHT_EMU = 618411
const FIRST_SIZE = 40
const box = (id: number, paragraphs: string[], size = FIRST_SIZE) =>
  buildAnchoredTextboxParagraphXml({
    anchor: 'paragraph',
    xEmu: 0,
    yEmu: -100000,
    widthEmu: WIDTH_EMU,
    heightEmu: HEIGHT_EMU,
    paragraphs: paragraphs.map((text) => ({ runs: [{ text, sizeHalfPoints: size }] })),
    id,
    fillHex: 'FFFFFF',
    insetsEmu: { l: 0, t: 0, r: 0, b: 0 },
    wrap: 'none',
    holderLineTwips: 20,
  })
const cell = (text: string, ...boxes: string[]) =>
  `<w:tc><w:p><w:r><w:t>${text}</w:t></w:r></w:p>${boxes.join('')}</w:tc>`
const table = (...cells: string[]) =>
  `<w:tbl><w:tblPr/><w:tblGrid>${cells.map(() => '<w:gridCol w:w="3000"/>').join('')}</w:tblGrid><w:tr>${cells.join('')}</w:tr></w:tbl>`

const live: Editor[] = []
afterEach(() => live.splice(0).forEach((e) => e.destroy()))
async function open(bodyXml: string) {
  const bytes = await buildDocx({
    bodyXml: `<w:p><w:r><w:t>Before</w:t></w:r></w:p>${bodyXml}<w:p/>`,
  })
  const parsed = await parseDocx(bytes)
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: blocksToPmDoc(parsed.blocks) as never,
  })
  live.push(editor)
  return { parsed, editor }
}
const entries = (editor: Editor) =>
  readRunGroups(editor, 0, editor.state.doc.childCount - 1).filter((e) => e.box !== undefined)
const translate = (editor: Editor, index: number, box: number, texts: string[]) =>
  applyRunTranslations(
    editor,
    entries(editor)
      .filter((e) => e.box === box && e.index === index)
      .map((e, i) => ({ index, box, paragraph: e.paragraph!, fp: e.fp, segments: [texts[i]!] })),
  )
/** the sizes (half-points) of the runs of the boxes, from the model */
const sizesOf = (editor: Editor) => {
  const sizes: number[][] = []
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'docCellBoxes' || node.attrs?.textboxes) {
      const boxes = (node.attrs.boxes ?? node.attrs.textboxes) as {
        paras: { runs: { sizeHalfPoints?: number }[] }[]
      }[]
      for (const b of boxes)
        sizes.push(b.paras.flatMap((p) => p.runs.map((r) => r.sizeHalfPoints ?? -1)))
    }
  })
  return sizes
}
const BOX_WIDTH_PT = WIDTH_EMU / 12700
const BOX_HEIGHT_PT = HEIGHT_EMU / 12700
const wsz = (xml: string) => [...xml.matchAll(/<w:sz w:val="(\d+)"/g)].map((m) => Number(m[1]))

describe('translating the text of a box in a table cell', () => {
  it('makes the text smaller when the translation is longer than the box holds', async () => {
    const { editor } = await open(table(cell('A', box(1, ['조림']))))
    const text = 'Braised short ribs'
    const outcome = translate(editor, 1, 0, [text])
    expect(outcome.ok).toBe(true)
    const [[size]] = sizesOf(editor) as [[number]]
    expect(size).toBeLessThan(FIRST_SIZE)
    // and the estimate says the lines now fit the height: wrapped at the width, 1.2 lines per size
    const lines = Math.max(1, Math.ceil((estimateTextEm(text) * (size / 2) * 1.12) / BOX_WIDTH_PT))
    expect(lines * (size / 2) * 1.2).toBeLessThanOrEqual(BOX_HEIGHT_PT + 0.01)
  })

  it('keeps the size when the translation fits', async () => {
    const { editor } = await open(table(cell('A', box(1, ['조림']))))
    translate(editor, 1, 0, ['Ribs'])
    expect(sizesOf(editor)).toEqual([[FIRST_SIZE]])
  })

  it('never makes the text larger, however short the translation', async () => {
    const { editor } = await open(table(cell('A', box(1, ['아주 긴 원래 글자 한 줄']))))
    translate(editor, 1, 0, ['Hi'])
    expect(sizesOf(editor)).toEqual([[FIRST_SIZE]])
  })

  it('makes every paragraph of the box smaller by the same step, so they stay alike', async () => {
    const { editor } = await open(table(cell('A', box(1, ['조림', '소갈비']))))
    translate(editor, 1, 0, ['Braised short ribs in soy sauce', 'Beef ribs with vegetables'])
    const [sizes] = sizesOf(editor) as [number[]]
    expect(sizes[0]).toBe(sizes[1])
    expect(sizes[0]).toBeLessThan(FIRST_SIZE)
  })

  it('leaves a box whose height is not fixed alone: it grows with its text', async () => {
    const { editor } = await open(table(cell('A', box(1, ['조림']))))
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name !== 'docCellBoxes') return
      const boxes = (node.attrs.boxes as Record<string, unknown>[]).map((b) => ({
        ...b,
        heightPx: undefined,
      }))
      editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { boxes }))
    })
    translate(editor, 1, 0, ['Braised short ribs'])
    expect(sizesOf(editor)).toEqual([[FIRST_SIZE]])
  })

  it('saves the smaller size with the translation, in the drawing and its fallback', async () => {
    const { parsed, editor } = await open(table(cell('A', box(1, ['조림']))))
    translate(editor, 1, 0, ['Braised short ribs'])
    const [[size]] = sizesOf(editor) as [[number]]
    const plan = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
    const out = await saveDocx(parsed, plan.saveBlocks)
    const xml = await (await JSZip.loadAsync(out)).file('word/document.xml')!.async('string')
    expect(xml).toContain('Braised short ribs')
    expect(wsz(xml).filter((n) => n === size).length).toBeGreaterThanOrEqual(2)
    expect(wsz(xml)).not.toContain(FIRST_SIZE)
  })

  it('does not touch the size of a box that was not translated', async () => {
    const { editor } = await open(table(cell('A', box(1, ['조림'])), cell('B', box(2, ['소갈비']))))
    translate(editor, 1, 0, ['Braised short ribs'])
    const [first, second] = sizesOf(editor) as [number[], number[]]
    expect(first[0]).toBeLessThan(FIRST_SIZE)
    expect(second).toEqual([FIRST_SIZE])
  })
})

describe('translating the text of a text box in the body', () => {
  it('makes the text smaller when it would run past a box of fixed size', async () => {
    const { editor } = await open(`<w:p>${box(1, ['조림']).replace(/^<w:p>|<\/w:p>$/g, '')}</w:p>`)
    const body = entries(editor).find((e) => e.box !== undefined)
    expect(body).toBeDefined()
    translate(editor, body!.index, body!.box!, ['Braised short ribs'])
    const [[size]] = sizesOf(editor) as [[number]]
    expect(size).toBeLessThan(FIRST_SIZE)
  })
})

describe('typing the translation into a box by hand', () => {
  const boxElements = (editor: Editor) => [
    ...editor.view.dom.querySelectorAll<HTMLElement>('.doc-cell-boxes .doc-textbox'),
  ]
  /** click into the box, type, and leave it: the way a person writes the translation in */
  const typeInto = (editor: Editor, text: string) => {
    const [el] = boxElements(editor)
    el!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
    el!.querySelector('.doc-textbox-para')!.textContent = text
    el!.dispatchEvent(new Event('input', { bubbles: true }))
    el!.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }))
  }
  const attached = async () => {
    const bytes = await buildDocx({
      bodyXml: `<w:p><w:r><w:t>Before</w:t></w:r></w:p>${table(cell('A', box(1, ['조림'])))}<w:p/>`,
    })
    const parsed = await parseDocx(bytes)
    const host = document.body.appendChild(document.createElement('div'))
    const editor = new Editor({
      element: host,
      extensions: editorExtensions,
      content: blocksToPmDoc(parsed.blocks) as never,
    })
    live.push(editor)
    return editor
  }

  it('makes the text smaller when what was typed is longer than the box holds', async () => {
    const editor = await attached()
    typeInto(editor, 'Braised short ribs')
    const [[size]] = sizesOf(editor) as [[number]]
    expect(size).toBeLessThan(FIRST_SIZE)
  })

  it('keeps the size when what was typed fits', async () => {
    const editor = await attached()
    typeInto(editor, 'Ribs')
    expect(sizesOf(editor)).toEqual([[FIRST_SIZE]])
  })
})
