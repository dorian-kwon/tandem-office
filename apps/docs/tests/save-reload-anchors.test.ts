import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { undo, redo } from '@tiptap/pm/history'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { applyAnchorOnlyReload } from '../src/renderer/save-reload'
import { carryDocSeen, executeTool, markDocSeen } from '../src/renderer/ai/tools'

/**
 * The save flow re-parses the saved bytes. When that document equals the live one apart from
 * docxIndex anchors, only the anchors are rewritten (no setContent, history kept).
 */

const para = (text: string, docxIndex: number | null) => ({
  type: 'docParagraph',
  attrs: { docxIndex },
  content: [{ type: 'text', text }],
})
const docOf = (...paras: ReturnType<typeof para>[]) => ({ type: 'doc', content: paras })

function makeEditor(): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: docOf(para('one', 0), para('two', 1)),
  })
}

const texts = (e: Editor) => e.state.doc.textContent
const indexes = (e: Editor) => {
  const out: unknown[] = []
  e.state.doc.forEach((n) => out.push(n.attrs.docxIndex))
  return out
}
const undoNow = (e: Editor) => undo(e.state, e.view.dispatch)
const redoNow = (e: Editor) => redo(e.state, e.view.dispatch)

describe('applyAnchorOnlyReload', () => {
  it('refreshes anchors without touching undo history, and undo/redo still work', () => {
    const editor = makeEditor()
    editor.commands.insertContentAt(4, 'X')
    expect(texts(editor)).toBe('oneXtwo')
    editor.commands.setTextSelection(3)
    // the edited paragraph and a new one get fresh anchors in the re-parse
    const mode = applyAnchorOnlyReload(editor, docOf(para('oneX', 5), para('two', 6)))
    expect(mode).toBe('anchors')
    expect(indexes(editor)).toEqual([5, 6])
    expect(editor.state.selection.from).toBe(3)
    expect(undoNow(editor)).toBe(true)
    expect(texts(editor)).toBe('onetwo')
    expect(redoNow(editor)).toBe(true)
    expect(texts(editor)).toBe('oneXtwo')
  })

  it('keeps the AI baseline: an index-addressed tool is refused without carryDocSeen, accepted with it', async () => {
    const run = (e: Editor) =>
      executeTool(
        e,
        {
          id: 's',
          name: 'replace_blocks',
          input: { startBlockIndex: 0, endBlockIndex: 0, html: '<p>new</p>' },
        },
        { bullet: '1', ordered: '2' },
      )
    const without = makeEditor()
    markDocSeen(without)
    applyAnchorOnlyReload(without, docOf(para('one', 7), para('two', 8)))
    expect((await run(without)).isError).toBe(true)

    const withCarry = makeEditor()
    markDocSeen(withCarry)
    const before = withCarry.state.doc
    applyAnchorOnlyReload(withCarry, docOf(para('one', 7), para('two', 8)))
    carryDocSeen(withCarry, before)
    const result = await run(withCarry)
    expect(result.isError).toBeFalsy()
    expect(withCarry.state.doc.child(0).textContent).toBe('new')
  })

  it('reports same when nothing differs and null when the content differs', () => {
    const editor = makeEditor()
    const doc = editor.state.doc
    expect(applyAnchorOnlyReload(editor, docOf(para('one', 0), para('two', 1)))).toBe('same')
    expect(editor.state.doc).toBe(doc)
    expect(applyAnchorOnlyReload(editor, docOf(para('one', 0), para('TWO', 1)))).toBeNull()
    expect(applyAnchorOnlyReload(editor, docOf(para('one', 0)))).toBeNull()
    expect(editor.state.doc).toBe(doc)
  })

  it('ignores aiChanged and leaves the live value', () => {
    const editor = makeEditor()
    const withFlag = {
      ...para('one', 0),
      attrs: { docxIndex: 0, aiChanged: true },
    }
    editor.commands.setContent(docOf(withFlag, para('two', 1)) as never)
    expect(applyAnchorOnlyReload(editor, docOf(para('one', 3), para('two', 1)))).toBe('anchors')
    expect(editor.state.doc.child(0).attrs.aiChanged).toBe(true)
    expect(indexes(editor)).toEqual([3, 1])
  })
})
