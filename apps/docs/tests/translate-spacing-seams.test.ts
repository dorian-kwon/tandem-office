import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import type { PmNode } from '../src/renderer/editor/convert'
import { applyRunTranslation, readRunGroups } from '../src/renderer/ai/translate-runs'

/**
 * Stray spaces that survived the first spacing clean-up in a real run: they sit
 * in whitespace-only runs (never shown to the model) or next to an inline
 * object, so the text tidy that only sees the segments could not reach them.
 */

const A = { font: 'Batang', sizeHalfPoints: 22, rawRPr: '<w:rPr/>' }
const B = { font: 'Batang', sizeHalfPoints: 22, rawRPr: '<w:rPr><w:i/></w:rPr>' }
const C = { font: 'Gulim', sizeHalfPoints: 22, rawRPr: '<w:rPr><w:b/></w:rPr>' }
const text = (t: string, style: Record<string, unknown>): PmNode => ({
  type: 'text',
  text: t,
  marks: [{ type: 'docTextStyle', attrs: style }],
})
const noteRef = (id: string): PmNode => ({
  type: 'docNoteRef',
  attrs: { kind: 'footnote', id, num: Number(id), rawRPr: '<w:rPr/>' },
})

const editors: Editor[] = []
afterEach(() => {
  for (const e of editors.splice(0)) e.destroy()
})
async function translate(content: PmNode[], segments: string[]): Promise<string> {
  const { editorExtensions } = await import('../src/renderer/editor/extensions')
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
  })
  editors.push(editor)
  editor.view.dispatch(
    editor.state.tr.replaceWith(0, editor.state.doc.content.size, [
      editor.schema.nodeFromJSON({ type: 'docParagraph', attrs: {}, content: content }),
    ]),
  )
  const fp = readRunGroups(editor, 0, 0)[0].fp
  const result = applyRunTranslation(editor, 0, segments, {})
  expect(result.ok).toBe(true)
  expect(fp).toBeTruthy()
  return editor.state.doc.child(0).textBetween(0, editor.state.doc.child(0).content.size, '', '⁠')
}

describe('stray spaces next to separators the model never sees', () => {
  it('drops the leading space the model wrote when a whitespace run follows a footnote mark', async () => {
    const out = await translate(
      [text('맡아 해주는 곳으로,', A), noteRef('1'), text(' ', B), text('요즘으로 치면', C)],
      ['among other services;', " in today's terms"],
    )
    expect(out).toBe("among other services;⁠ in today's terms")
  })

  it('drops the trailing space when a whitespace run sits before a footnote mark', async () => {
    const out = await translate(
      [text('앞 문장', A), text(' ', B), noteRef('1'), text('뒤 문장', C)],
      ['First sentence. ', 'Second sentence.'],
    )
    expect(out).toBe('First sentence. \u2060Second sentence.')
  })

  it('removes the whitespace run that would put a space before a comma after emptied groups', async () => {
    const out = await translate(
      [
        text('화가 도미야마', A),
        text('와 나눈', B),
        text(' ', A),
        text('대담', C),
        text('에 기록된', A),
      ],
      ['painter Tomiyama', '', '', ', contain points'],
    )
    expect(out).toBe('painter Tomiyama, contain points')
  })

  it('removes the whitespace run before a full stop that follows an emptied group', async () => {
    const out = await translate(
      [text('읽을 수 있게', A), text(' ', B), text('했', C), text('다. ', A)],
      ['so that they can read the score', '', '. '],
    )
    expect(out).toBe('so that they can read the score. ')
  })

  it('does not add a second space for a whitespace-only segment beside a whitespace run', async () => {
    const out = await translate(
      [text('를', A), text(' ', B), text('문', C), text('자 그대로', A)],
      [' that he included in the book', ' ', 'literally, one to one,'],
    )
    expect(out).toBe(' that he included in the book literally, one to one,')
  })
})
