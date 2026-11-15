import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import JSZip from 'jszip'
import { buildAnchoredTextboxParagraphXml, parseDocx, saveDocx } from '@genoffice/docx-engine'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { blocksToPmDoc, pmDocToSavePlan, type PmNode } from '../src/renderer/editor/convert'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { readRunGroups } from '../src/renderer/ai/translate-runs'

/**
 * The text of a box inside a table cell (the boxes OCR puts over a picture) is edited where it
 * stands: double-click, type, leave. The new text goes into the model and is saved into the
 * original table bytes by the same path the translation uses.
 */

const box = (id: number, text: string) =>
  buildAnchoredTextboxParagraphXml({
    anchor: 'paragraph',
    xEmu: 0,
    yEmu: -100000,
    widthEmu: 1500000,
    heightEmu: 400000,
    paragraphs: [{ runs: [{ text }] }],
    id,
    fillHex: 'FFFFFF',
    wrap: 'none',
    holderLineTwips: 20,
  })
const cell = (text: string, ...boxes: string[]) =>
  `<w:tc><w:p><w:r><w:t>${text}</w:t></w:r></w:p>${boxes.join('')}</w:tc>`
const table = (...cells: string[]) =>
  `<w:tbl><w:tblPr/><w:tblGrid>${cells.map(() => '<w:gridCol w:w="3000"/>').join('')}</w:tblGrid><w:tr>${cells.join('')}</w:tr></w:tbl>`

const live: Editor[] = []
beforeEach(() => {
  // the test environment has no layout: ProseMirror asks where a click landed
  document.elementFromPoint = () => null
  // nor does it measure text: undo scrolls the selection into view
  const none = () => [] as unknown as DOMRectList
  Range.prototype.getClientRects ??= none
  Range.prototype.getBoundingClientRect ??= () => new DOMRect()
})
afterEach(() => {
  live.splice(0).forEach((e) => e.destroy())
  document.body.replaceChildren()
})

async function open(...cells: string[]) {
  const bytes = await buildDocx({
    bodyXml: `<w:p><w:r><w:t>Before</w:t></w:r></w:p>${table(...cells)}<w:p/>`,
  })
  const parsed = await parseDocx(bytes)
  // in the page, like the real editor: a click outside a box reaches the document
  const host = document.body.appendChild(document.createElement('div'))
  const editor = new Editor({
    element: host,
    extensions: editorExtensions,
    content: blocksToPmDoc(parsed.blocks) as never,
  })
  live.push(editor)
  return { parsed, editor }
}
const boxEls = (editor: Editor) => [
  ...editor.view.dom.querySelectorAll<HTMLElement>('.doc-cell-boxes .doc-textbox'),
]
const texts = (editor: Editor) =>
  readRunGroups(editor, 0, editor.state.doc.childCount - 1)
    .filter((e) => e.box !== undefined)
    .map((e) => e.segments?.[0])
const wt = (xml: string) => [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1])

/** one click on the text of a box: the caret goes where it was clicked */
const startEditing = (el: HTMLElement) =>
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
const type = (el: HTMLElement, text: string) => {
  el.querySelector('.doc-textbox-para')!.textContent = text
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
const leave = (el: HTMLElement) =>
  el.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }))
const cellBoxNodes = (editor: Editor) => {
  const found: { node: ReturnType<Editor['state']['doc']['nodeAt']>; pos: number }[] = []
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'docCellBoxes') found.push({ node, pos })
  })
  return found
}

describe('editing the text of a box in a table cell', () => {
  it('turns on editing for a box when it is clicked, and only for that box', async () => {
    const { editor } = await open(cell('A', box(1, 'ONE')), cell('B', box(2, 'TWO')))
    const [first, second] = boxEls(editor)
    expect(first!.getAttribute('contenteditable')).not.toBe('true')
    startEditing(first!)
    expect(first!.getAttribute('contenteditable')).toBe('true')
    expect(second!.getAttribute('contenteditable')).not.toBe('true')
  })

  it('also takes a double-click, for a person who is used to it', async () => {
    const { editor } = await open(cell('A', box(1, 'ONE')))
    const [first] = boxEls(editor)
    first!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    expect(first!.getAttribute('contenteditable')).toBe('true')
  })

  it('does not take a click with another button or with a modifier key (a menu, a selection)', async () => {
    const { editor } = await open(cell('A', box(1, 'ONE')))
    const [first] = boxEls(editor)
    first!.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 }),
    )
    first!.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, shiftKey: true }),
    )
    expect(first!.getAttribute('contenteditable')).not.toBe('true')
  })

  it('does not take the click away from the text being edited (the caret stays where it is put)', async () => {
    const { editor } = await open(cell('A', box(1, 'ONE')))
    const [first] = boxEls(editor)
    startEditing(first!)
    const again = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })
    first!.dispatchEvent(again)
    expect(again.defaultPrevented).toBe(false)
    expect(first!.getAttribute('contenteditable')).toBe('true')
  })

  it('clicking another box finishes the first and keeps what was typed in it', async () => {
    const { editor } = await open(cell('A', box(1, 'ONE')), cell('B', box(2, 'TWO')))
    const [first, second] = boxEls(editor)
    startEditing(first!)
    type(first!, 'ONE EDITED')
    startEditing(second!)
    expect(first!.getAttribute('contenteditable')).not.toBe('true')
    expect(second!.getAttribute('contenteditable')).toBe('true')
    expect(texts(editor)).toEqual(['ONE EDITED', 'TWO'])
  })

  it('writes what was typed into the model when the person leaves the box', async () => {
    const { editor } = await open(cell('A', box(1, 'ONE')), cell('B', box(2, 'TWO')))
    const [first] = boxEls(editor)
    startEditing(first!)
    type(first!, 'ONE EDITED')
    leave(first!)
    expect(texts(editor)).toEqual(['ONE EDITED', 'TWO'])
  })

  it('saves the edited text into the original table, the drawing and its fallback, and nothing else', async () => {
    const { parsed, editor } = await open(cell('A', box(1, 'ONE')), cell('B', box(2, 'TWO')))
    const [first] = boxEls(editor)
    startEditing(first!)
    type(first!, 'ONE EDITED')
    leave(first!)
    const plan = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
    const out = await saveDocx(parsed, plan.saveBlocks)
    const xml = await (await JSZip.loadAsync(out)).file('word/document.xml')!.async('string')
    expect(wt(xml)).toEqual(['Before', 'A', 'ONE EDITED', 'ONE EDITED', 'B', 'TWO', 'TWO'])
  })

  it('can be undone', async () => {
    const { editor } = await open(cell('A', box(1, 'ONE')))
    const [first] = boxEls(editor)
    startEditing(first!)
    type(first!, 'CHANGED')
    leave(first!)
    expect(texts(editor)).toEqual(['CHANGED'])
    editor.commands.undo()
    expect(texts(editor)).toEqual(['ONE'])
  })

  it('does not touch the document when the text is left as it was', async () => {
    const { editor } = await open(cell('A', box(1, 'ONE')))
    const before = editor.state.doc
    const [first] = boxEls(editor)
    startEditing(first!)
    leave(first!)
    expect(editor.state.doc).toBe(before)
  })

  it('keeps the line breaks out: Enter does nothing while editing, Escape finishes', async () => {
    const { editor } = await open(cell('A', box(1, 'ONE')))
    const [first] = boxEls(editor)
    startEditing(first!)
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    first!.dispatchEvent(enter)
    expect(enter.defaultPrevented).toBe(true)
    type(first!, 'DONE')
    first!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(first!.getAttribute('contenteditable')).not.toBe('true')
    expect(texts(editor)).toEqual(['DONE'])
  })

  it('leaves a box alone when it cannot be saved (no place in the table was found for it)', async () => {
    const { editor } = await open(cell('A', box(1, 'ONE')))
    const [{ node, pos }] = cellBoxNodes(editor)
    const boxes = (node!.attrs.boxes as Record<string, unknown>[]).map((b) => ({
      ...b,
      tableSegment: undefined,
    }))
    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { boxes }))
    const [first] = boxEls(editor)
    startEditing(first!)
    expect(first!.getAttribute('contenteditable')).not.toBe('true')
  })

  it('does not edit while the editor is read-only', async () => {
    const { editor } = await open(cell('A', box(1, 'ONE')))
    editor.setEditable(false)
    const [first] = boxEls(editor)
    startEditing(first!)
    expect(first!.getAttribute('contenteditable')).not.toBe('true')
  })

  it('does not lose a paragraph when the box is left with fewer than it had', async () => {
    const two = buildAnchoredTextboxParagraphXml({
      anchor: 'paragraph',
      xEmu: 0,
      yEmu: -100000,
      widthEmu: 1500000,
      heightEmu: 400000,
      paragraphs: [{ runs: [{ text: 'LINE ONE' }] }, { runs: [{ text: 'LINE TWO' }] }],
      id: 5,
      fillHex: 'FFFFFF',
      wrap: 'none',
      holderLineTwips: 20,
    })
    const { editor } = await open(cell('A', two))
    const [first] = boxEls(editor)
    startEditing(first!)
    // the second paragraph element is removed by the browser (Backspace at its start)
    first!.querySelectorAll('.doc-textbox-para')[1]!.remove()
    first!.dispatchEvent(new Event('input', { bubbles: true }))
    leave(first!)
    const entries = readRunGroups(editor, 0, editor.state.doc.childCount - 1).filter(
      (e) => e.box !== undefined,
    )
    expect(entries.map((e) => e.segments?.[0])).toEqual(['LINE ONE', 'LINE TWO'])
  })
})
