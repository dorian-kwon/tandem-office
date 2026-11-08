import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { replaceSnapshot, snapshotSelection } from '../src/renderer/compare/replace-selection'
import { locateRange, sourceTextFor, textAt } from '../src/renderer/compare/source-locate'

const text = (t: string, marks?: unknown[]) => ({
  type: 'text',
  text: t,
  ...(marks ? { marks } : {}),
})
const para = (...content: unknown[]) => ({
  type: 'docParagraph',
  attrs: { docxIndex: null },
  content,
})

const live: Editor[] = []
function make(content: unknown[]): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: { type: 'doc', content } as never,
  })
  live.push(editor)
  return editor
}
afterEach(() => {
  for (const e of live.splice(0)) e.destroy()
})

const styled = () => [
  para(
    text('Revenue grew '),
    text('eight percent', [{ type: 'bold' }, { type: 'docTextStyle', attrs: { color: 'FF0000' } }]),
    text(' year over year.'),
  ),
  para(text('Second paragraph.')),
]

describe('AI compare replacement', () => {
  it('keeps the run marks of the replaced text and is one undo step', () => {
    const editor = make(styled())
    editor.commands.setTextSelection({ from: 14, to: 27 })
    const snap = snapshotSelection(editor)!
    expect(snap.fingerprint).toBe('eight percent')
    // the selection may move on before "use this" is pressed
    editor.commands.setTextSelection(3)
    expect(replaceSnapshot(editor, snap, '8%')).toEqual({ ok: true })
    const p = editor.state.doc.child(0)
    expect(p.textContent).toBe('Revenue grew 8% year over year.')
    const run = p.child(1)
    expect(run.text).toBe('8%')
    expect(run.marks.map((m) => m.type.name).sort()).toEqual(['bold', 'docTextStyle'])
    expect(editor.commands.undo()).toBe(true)
    expect(editor.state.doc.child(0).textContent).toBe('Revenue grew eight percent year over year.')
    // one step: nothing more to undo
    expect(editor.commands.undo()).toBe(false)
  })

  it('is refused when the text under the range changed since the popup opened', () => {
    const editor = make(styled())
    editor.commands.setTextSelection({ from: 14, to: 27 })
    const snap = snapshotSelection(editor)!
    editor.commands.insertContentAt(1, 'X')
    const before = editor.state.doc.textContent
    expect(replaceSnapshot(editor, snap, '8%')).toEqual({ ok: false, reason: 'stale' })
    expect(editor.state.doc.textContent).toBe(before)
  })

  it('replaces text inside one paragraph of a table cell and flags only that paragraph', () => {
    const cell = (t: string) => ({
      type: 'docTableCell',
      attrs: { colwidth: [100] },
      content: [para(text(t))],
    })
    const table = {
      type: 'docTable',
      attrs: { docxIndex: 3 },
      content: [
        { type: 'docTableRow', content: [cell('Inscription of the Archives'), cell('Other')] },
      ],
    }
    const editor = make([para(text('Before')), table])
    let from = -1
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'Inscription of the Archives') from = pos
    })
    editor.commands.setTextSelection({ from: from + 15, to: from + 27 })
    const snap = snapshotSelection(editor)!
    expect(snap.fingerprint).toBe('the Archives')
    expect(replaceSnapshot(editor, snap, 'THE RECORDS')).toEqual({ ok: true })
    expect(editor.state.doc.textContent).toContain('Inscription of THE RECORDS')
    expect(editor.state.doc.textContent).toContain('Other')
    // only the cell's paragraph is flagged as changed, not the whole table
    expect(editor.state.doc.child(1).attrs.aiChanged ?? false).toBe(false)
    expect(editor.commands.undo()).toBe(true)
    expect(editor.state.doc.textContent).toContain('Inscription of the Archives')
  })

  it('is refused across paragraphs and for empty text', () => {
    const editor = make(styled())
    editor.commands.setTextSelection({ from: 5, to: 50 })
    const snap = snapshotSelection(editor)!
    expect(replaceSnapshot(editor, snap, 'x')).toEqual({ ok: false, reason: 'unsupported' })
    editor.commands.setTextSelection({ from: 14, to: 27 })
    expect(replaceSnapshot(editor, snapshotSelection(editor)!, '   ')).toEqual({
      ok: false,
      reason: 'empty',
    })
  })

  it('records a tracked change when tracking is on: old text struck, new text inserted', () => {
    const editor = make(styled())
    editor.commands.setTextSelection({ from: 14, to: 27 })
    const snap = snapshotSelection(editor)!
    expect(replaceSnapshot(editor, snap, '8%', { author: 'Tester' })).toEqual({ ok: true })
    const names: string[] = []
    editor.state.doc.child(0).forEach((n) => {
      for (const m of n.marks)
        if (m.type.name === 'ins' || m.type.name === 'del') names.push(`${m.type.name}:${n.text}`)
    })
    expect(names).toEqual(['del:eight percent', 'ins:8%'])
  })

  it('a multi-line candidate becomes one line inside the paragraph', () => {
    const editor = make(styled())
    editor.commands.setTextSelection({ from: 14, to: 27 })
    replaceSnapshot(editor, snapshotSelection(editor)!, 'about\n8%')
    expect(editor.state.doc.child(0).textContent).toBe('Revenue grew about 8% year over year.')
    expect(editor.state.doc.childCount).toBe(2)
  })
})

describe('source paragraph lookup by block position', () => {
  const table = (...cells: string[]) => ({
    type: 'docTable',
    attrs: { docxIndex: null },
    content: [
      {
        type: 'docTableRow',
        content: cells.map((c) => ({ type: 'docTableCell', content: [para(text(c))] })),
      },
    ],
  })

  it('maps paragraphs of the output to the same positions of the source', () => {
    const out = make([para(text('One.')), para(text('Two.')), para(text('Three.'))])
    const src = make([para(text('하나.')), para(text('둘.')), para(text('셋.'))])
    // select inside the second paragraph
    const p2 = out.state.doc.child(0).nodeSize
    expect(sourceTextFor(out.state.doc, src.state.doc, p2 + 2, p2 + 4)).toBe('둘.')
    // a selection over two paragraphs gives both lines
    expect(sourceTextFor(out.state.doc, src.state.doc, 2, p2 + 4)).toBe('하나.\n둘.')
  })

  it('does not guess when the structure differs', () => {
    const out = make([para(text('One.')), para(text('Two.'))])
    const src = make([para(text('하나.'))])
    expect(sourceTextFor(out.state.doc, src.state.doc, 2, 4)).toBeNull()
  })

  it('a table cell paragraph is found by its ordinal inside the table', () => {
    const out = make([para(text('Intro')), table('A one', 'B two')])
    const src = make([para(text('서론')), table('가', '나')])
    const doc = out.state.doc
    let pos = -1
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'B two') pos = p
    })
    expect(locateRange(doc, pos, pos + 3)).toEqual([{ index: 1, ordinal: 1 }])
    expect(textAt(src.state.doc, locateRange(doc, pos, pos + 3))).toBe('나')
  })
})

it('keeps comparison replacements separate from preceding and following typing in undo history', () => {
  const editor = make([para(text('One')), para(text('Two'))])
  editor.commands.insertContentAt(1, 'Typed ')
  editor.commands.setTextSelection({ from: 1, to: 10 })
  expect(replaceSnapshot(editor, snapshotSelection(editor)!, 'Changed')).toEqual({ ok: true })
  editor.commands.insertContentAt(8, '!')
  expect(editor.commands.undo()).toBe(true)
  expect(editor.state.doc.child(0).textContent).toBe('Changed')
  expect(editor.commands.undo()).toBe(true)
  expect(editor.state.doc.child(0).textContent).toBe('Typed One')
  expect(editor.commands.undo()).toBe(true)
  expect(editor.state.doc.child(0).textContent).toBe('One')
})

it('does not guess an original when the matching block has a different structure', () => {
  const out = make([para(text('Target paragraph'))])
  const src = make([
    {
      type: 'docTable',
      content: [
        {
          type: 'docTableRow',
          content: [{ type: 'docTableCell', content: [para(text('Unrelated source'))] }],
        },
      ],
    },
  ])
  expect(sourceTextFor(out.state.doc, src.state.doc, 1, 5)).toBeNull()
})
