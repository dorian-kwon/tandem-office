import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import {
  currentText,
  enumerateUnits,
  enumerateSelectionUnits,
  mapRange,
} from '../src/renderer/compare/units'
import { replaceSnapshot } from '../src/renderer/compare/replace-selection'
const editors: Editor[] = []
const p = (text: string) => ({
  type: 'docParagraph',
  content: text ? [{ type: 'text', text }] : [],
})
function make(content: unknown[]) {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: { type: 'doc', content } as never,
  })
  editors.push(editor)
  return editor
}
afterEach(() => editors.splice(0).forEach((e) => e.destroy()))
describe('comparison paragraph units', () => {
  it('enumerates only text paragraphs, including table cell paragraphs in reading order', () => {
    const editor = make([
      p('First'),
      p(''),
      p('123'),
      p('***'),
      {
        type: 'docTable',
        content: [
          {
            type: 'docTableRow',
            content: [{ type: 'docTableCell', content: [p('Cell one'), p('Cell two')] }],
          },
        ],
      },
      p('Last'),
    ])
    const units = enumerateUnits(editor.state.doc)
    expect(units.map((u) => u.text)).toEqual(['First', 'Cell one', 'Cell two', 'Last'])
    expect(units.map((u) => currentText(editor, u))).toEqual([
      'First',
      'Cell one',
      'Cell two',
      'Last',
    ])
  })
  it('maps the next unit after an earlier replacement and keeps separate undo steps', () => {
    const editor = make([p('First'), p('Second')])
    const units = enumerateUnits(editor.state.doc)
    let range = { from: units[1]!.from, to: units[1]!.to, gone: false }
    editor.on('transaction', ({ transaction }) => {
      if (transaction.docChanged) range = mapRange(range, transaction.mapping)
    })
    expect(
      replaceSnapshot(editor, { ...units[0]!, fingerprint: 'First' }, 'Longer first paragraph'),
    ).toEqual({ ok: true })
    expect(currentText(editor, range)).toBe('Second')
    expect(replaceSnapshot(editor, { ...range, fingerprint: 'Second' }, 'Changed second')).toEqual({
      ok: true,
    })
    editor.commands.undo()
    expect(editor.state.doc.child(0).textContent).toBe('Longer first paragraph')
    expect(editor.state.doc.child(1).textContent).toBe('Second')
  })
  it('marks a unit gone after deletion instead of targeting the next paragraph', () => {
    const editor = make([p('First'), p('Second')])
    const unit = enumerateUnits(editor.state.doc)[0]!
    let range = { from: unit.from, to: unit.to, gone: false }
    editor.on('transaction', ({ transaction }) => {
      range = mapRange(range, transaction.mapping)
    })
    editor.commands.deleteRange({ from: 0, to: editor.state.doc.child(0).nodeSize })
    expect(range.gone).toBe(true)
    expect(editor.state.doc.textContent).toBe('Second')
  })
  it('splits a selection by paragraph and clips the boundary paragraphs exactly', () => {
    const editor = make([p('Outside before FIRST'), p('MIDDLE'), p('LAST outside after')])
    const third = editor.state.doc.child(0).nodeSize + editor.state.doc.child(1).nodeSize
    const units = enumerateSelectionUnits(editor.state.doc, { from: 16, to: third + 5 })
    expect(units.map((u) => u.text)).toEqual(['FIRST', 'MIDDLE', 'LAST'])
    expect(units[0]?.from).toBe(16)
    expect(units[2]?.to).toBe(third + 5)
    expect(units.map((u) => currentText(editor, u))).toEqual(['FIRST', 'MIDDLE', 'LAST'])
  })

  it('flags inline objects so applying cannot discard a footnote or line break', () => {
    const editor = make([
      {
        type: 'docParagraph',
        content: [
          { type: 'text', text: 'Before' },
          { type: 'hardBreak' },
          { type: 'text', text: 'After' },
        ],
      },
    ])
    expect(enumerateUnits(editor.state.doc)[0]?.hasObjects).toBe(true)
  })
})
