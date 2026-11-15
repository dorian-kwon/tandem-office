import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import {
  dropEditorRange,
  readBoxSelection,
  withBoxQuote,
} from '../src/renderer/editor/box-selection'

/**
 * Text selected with the mouse inside a text box. The boxes (the ones OCR puts over a picture,
 * and the ones of the document) are drawn and edited as islands of their own, so the editor has
 * no range there: the entry that offers "ask AI" on a selection reads the browser's selection.
 */

let root: HTMLElement

beforeEach(() => {
  // the test environment has no layout: a range knows no rectangles
  Range.prototype.getClientRects = function () {
    return [{ left: 10, top: 20, right: 90, bottom: 36, width: 80, height: 16 }] as never
  }
  root = document.createElement('div')
  root.innerHTML =
    '<p id="body">Body text</p>' +
    '<div class="doc-cell-boxes">' +
    '<div class="doc-textbox"><div class="doc-textbox-para" id="a">  Shop   name\n here </div></div>' +
    '<div class="doc-textbox"><div class="doc-textbox-para" id="b">Second box</div></div>' +
    '</div>'
  document.body.appendChild(root)
})
afterEach(() => {
  window.getSelection()?.removeAllRanges()
  root.remove()
})

function select(from: Node, fromOffset: number, to: Node, toOffset: number): void {
  const range = document.createRange()
  range.setStart(from, fromOffset)
  range.setEnd(to, toOffset)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}
const text = (id: string) => root.querySelector(`#${id}`)!.firstChild!

describe('reading a selection inside a text box', () => {
  it('gives the selected words, whitespace collapsed, and where the selection ends', () => {
    select(text('a'), 0, text('a'), (text('a') as Text).length)
    const read = readBoxSelection(root, window.getSelection())
    expect(read?.text).toBe('Shop name here')
    expect(read?.rect).toEqual({ left: 10, top: 20, right: 90, bottom: 36 })
  })

  it('gives nothing for a caret', () => {
    select(text('a'), 3, text('a'), 3)
    expect(readBoxSelection(root, window.getSelection())).toBeNull()
  })

  it('gives nothing for words outside any box: the editor knows those itself', () => {
    select(text('body'), 0, text('body'), 4)
    expect(readBoxSelection(root, window.getSelection())).toBeNull()
  })

  it('gives nothing for a selection that runs over two boxes', () => {
    select(text('a'), 0, text('b'), 3)
    expect(readBoxSelection(root, window.getSelection())).toBeNull()
  })

  it('gives nothing for white space only', () => {
    select(text('a'), 0, text('a'), 2)
    expect(readBoxSelection(root, window.getSelection())).toBeNull()
  })

  it('gives nothing for a box that is not inside the editor', () => {
    const other = document.createElement('div')
    other.innerHTML = '<div class="doc-textbox"><span id="o">Elsewhere</span></div>'
    document.body.appendChild(other)
    const word = other.querySelector('#o')!.firstChild!
    select(word, 0, word, 4)
    expect(readBoxSelection(root, window.getSelection())).toBeNull()
    other.remove()
  })

  it('gives nothing when there is no selection', () => {
    expect(readBoxSelection(root, null)).toBeNull()
  })
})

describe('the request for words picked in a box', () => {
  it('carries the words, since the editor has no range to name them', () => {
    expect(withBoxQuote(' Translate ', 'Shop name')).toBe('Translate\n\n"Shop name"')
  })
})

describe('a range chosen earlier in the body', () => {
  it('is collapsed, so the run is not scoped to words the person did not just pick', () => {
    const editor = new Editor({
      extensions: [Document, Paragraph, Text],
      content: '<p>Body text here</p>',
    })
    editor.commands.setTextSelection({ from: 1, to: 5 })
    expect(editor.state.selection.empty).toBe(false)
    dropEditorRange(editor)
    expect(editor.state.selection.empty).toBe(true)
    expect(editor.state.selection.from).toBe(5)
    editor.destroy()
  })

  it('leaves a caret where it is', () => {
    const editor = new Editor({
      extensions: [Document, Paragraph, Text],
      content: '<p>Body text here</p>',
    })
    editor.commands.setTextSelection(3)
    dropEditorRange(editor)
    expect(editor.state.selection.from).toBe(3)
    editor.destroy()
  })
})

describe('the entry that offers "ask AI"', () => {
  const popover = readFileSync(
    join(__dirname, '../src/renderer/components/AiAskPopover.tsx'),
    'utf8',
  )

  it('follows the words picked in a box of this editor, and sends them with the request', () => {
    expect(popover).toContain('readBoxSelection(editor.view.dom, window.getSelection())')
    expect(popover).toContain("document.addEventListener('selectionchange', update)")
    expect(popover).toContain('onSendNow(withBoxQuote(value, quote.text))')
  })

  it('drops the editor range first, and offers no queue for words that have no range', () => {
    expect(popover).toMatch(/dropEditorRange\(editor\)\s+onSendNow\(withBoxQuote/)
    expect(popover).toContain('{!boxQuote && (')
  })

  it('searches and translates the picked words on the web too', () => {
    expect(popover).toContain('const query = boxSel ? clipQuery(boxSel.text) : searchQuery(editor)')
  })
})
