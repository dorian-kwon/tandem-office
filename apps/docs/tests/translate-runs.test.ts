import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { BLANK_BULLET_NUM_ID, BLANK_ORDERED_NUM_ID } from '@genoffice/docx-engine'
import type { PmNode } from '../src/renderer/editor/convert'
import { applyRunTranslation, readRunGroups } from '../src/renderer/ai/translate-runs'
import { executeTool } from '../src/renderer/ai/tools'

/**
 * The run-preserving translation tool: read_runs lists each paragraph's text
 * as numbered segments (one per run of equal formatting), translate_blocks
 * swaps the text inside those runs and leaves every mark, atom node and
 * paragraph attribute as it was.
 */

const NUM_IDS = { bullet: BLANK_BULLET_NUM_ID, ordered: BLANK_ORDERED_NUM_ID }
const TRACK = { author: 'AI Assistant' }

const STYLE_A = {
  font: 'Batang',
  sizeHalfPoints: 22,
  rawRPr: '<w:rPr><w:rFonts w:hint="eastAsia"/></w:rPr>',
}
const STYLE_B = { font: 'Batang', sizeHalfPoints: 22, rawRPr: '<w:rPr><w:i/></w:rPr>' }
const STYLE_C = {
  font: 'Gulim',
  sizeHalfPoints: 18,
  color: 'FF0000',
  rawRPr: '<w:rPr><w:color w:val="FF0000"/></w:rPr>',
}
const PARA_ATTRS = { styleId: 'af5', indentFirstLine: 200, docxIndex: 3 }

const text = (t: string, style: Record<string, unknown>, extra: PmNode['marks'] = []): PmNode => ({
  type: 'text',
  text: t,
  marks: [{ type: 'docTextStyle', attrs: style }, ...(extra ?? [])],
})
const noteRef = (id: string): PmNode => ({
  type: 'docNoteRef',
  attrs: { kind: 'footnote', id, num: Number(id), rawRPr: '<w:rPr><w:rStyle w:val="a7"/></w:rPr>' },
})

const mixedParagraph: PmNode = {
  type: 'docParagraph',
  attrs: PARA_ATTRS,
  content: [
    text('첫째 문장 ', STYLE_A),
    text('기울임', STYLE_B),
    noteRef('1'),
    text(' 빨간 끝.', STYLE_C),
  ],
}
const emptyParagraph: PmNode = {
  type: 'docParagraph',
  attrs: { styleId: 'BlankLine', docxIndex: 4 },
}

const liveEditors: Editor[] = []
afterEach(() => {
  for (const editor of liveEditors.splice(0)) editor.destroy()
})

async function createEditor(blocks: PmNode[]): Promise<Editor> {
  const { editorExtensions } = await import('../src/renderer/editor/extensions')
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
  })
  liveEditors.push(editor)
  const pm = blocks.map((b) => editor.schema.nodeFromJSON(b))
  // setup is not an undo step: undo must reach exactly the tool's edit
  editor.view.dispatch(
    editor.state.tr
      .replaceWith(0, editor.state.doc.content.size, pm)
      .setMeta('addToHistory', false),
  )
  return editor
}

const blockJson = (editor: Editor, i: number): PmNode =>
  ((editor.getJSON() as PmNode).content ?? [])[i]

/** the block with every text replaced by a placeholder: what must not change */
function shape(node: PmNode): unknown {
  return {
    type: node.type,
    attrs: node.attrs,
    content: (node.content ?? []).map((c) =>
      c.type === 'text' ? { type: 'text', marks: c.marks } : c,
    ),
  }
}

const texts = (node: PmNode): string[] =>
  (node.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '')

describe('readRunGroups', () => {
  it('lists one segment per run of equal formatting; atoms split groups; empty paragraphs flagged', async () => {
    const editor = await createEditor([mixedParagraph, emptyParagraph])
    expect(readRunGroups(editor, 0, 1)).toEqual([
      { index: 0, segments: ['첫째 문장 ', '기울임', ' 빨간 끝.'] },
      { index: 1, empty: true },
    ])
  })

  it('skips tracked deletions and whitespace-only runs', async () => {
    const editor = await createEditor([
      {
        type: 'docParagraph',
        attrs: {},
        content: [
          text('살아 있는 글', STYLE_A),
          text(' ', STYLE_B),
          text('지운 글', STYLE_A, [{ type: 'del', attrs: { author: 'X' } }]),
          text('뒤의 글', STYLE_C),
        ],
      },
    ])
    expect(readRunGroups(editor, 0, 0)).toEqual([
      { index: 0, segments: ['살아 있는 글', '뒤의 글'] },
    ])
  })

  it('lists table cell paragraphs one by one', async () => {
    const cell = (t: string) => ({
      type: 'docTableCell',
      content: [{ type: 'docParagraph', content: [text(t, STYLE_A)] }],
    })
    const editor = await createEditor([
      {
        type: 'docTable',
        content: [{ type: 'docTableRow', content: [cell('칸 하나'), cell('칸 둘')] }],
      },
    ])
    expect(readRunGroups(editor, 0, 0)).toEqual([
      { index: 0, paragraph: 0, segments: ['칸 하나'] },
      { index: 0, paragraph: 1, segments: ['칸 둘'] },
    ])
  })
})

describe('applyRunTranslation', () => {
  it('(a) keeps run count, marks, the footnote reference and paragraph attrs; only text changes', async () => {
    const editor = await createEditor([mixedParagraph])
    const before = blockJson(editor, 0)
    const result = applyRunTranslation(editor, 0, ['First sentence', 'italic', 'red end.'])
    expect(result.ok).toBe(true)
    expect(result.incomplete).toBeUndefined()
    const after = blockJson(editor, 0)
    // edge whitespace of each run is kept even when the segment drops it
    expect(texts(after)).toEqual(['First sentence ', 'italic', ' red end.'])
    // aiChanged is the editor's display-only "changed by AI" highlight
    expect(after.attrs?.aiChanged).toBe(true)
    const withoutHighlight = (n: PmNode): PmNode => ({
      ...n,
      attrs: { ...n.attrs, aiChanged: false },
    })
    expect(shape(withoutHighlight(after))).toEqual(shape(withoutHighlight(before)))
    expect(after.content?.[2]).toEqual(before.content?.[2])
  })

  it('(b) an empty paragraph is left untouched', async () => {
    const editor = await createEditor([mixedParagraph, emptyParagraph])
    const before = blockJson(editor, 1)
    const result = applyRunTranslation(editor, 1, ['should not land'])
    expect(result.ok).toBe(true)
    expect(result.empty).toBe(true)
    expect(blockJson(editor, 1)).toEqual(before)
  })

  it('(c) fewer segments than groups: reported, the rest keeps its original text', async () => {
    const editor = await createEditor([mixedParagraph])
    const result = applyRunTranslation(editor, 0, ['First sentence'])
    expect(result.incomplete).toEqual({ groups: 3, given: 1 })
    expect(texts(blockJson(editor, 0))).toEqual(['First sentence ', '기울임', ' 빨간 끝.'])
  })

  it('(d) more segments than groups: the extra ones are appended to the last group', async () => {
    const editor = await createEditor([mixedParagraph])
    const result = applyRunTranslation(editor, 0, ['One', 'two', 'three', 'and four.'])
    expect(result.ok).toBe(true)
    expect(result.extra).toBe(1)
    expect(texts(blockJson(editor, 0))).toEqual(['One ', 'two', ' three and four.'])
  })

  it('(e) tracked-deleted text is skipped and stays as it was', async () => {
    const del = [{ type: 'del', attrs: { author: 'X', date: null, dateUtc: null, id: null } }]
    const editor = await createEditor([
      {
        type: 'docParagraph',
        attrs: {},
        content: [text('앞 글', STYLE_A), text('지운 글', STYLE_B, del), text('뒤 글', STYLE_C)],
      },
    ])
    applyRunTranslation(editor, 0, ['Front', 'Back'])
    const after = blockJson(editor, 0)
    expect(texts(after)).toEqual(['Front', '지운 글', 'Back'])
    expect(after.content?.[1].marks?.some((m) => m.type === 'del')).toBe(true)
  })

  it('keeps tab characters and hard breaks between groups', async () => {
    const editor = await createEditor([
      {
        type: 'docParagraph',
        attrs: {},
        content: [text('왼쪽\t오른쪽', STYLE_A), { type: 'hardBreak' }, text('다음 줄', STYLE_A)],
      },
    ])
    expect(readRunGroups(editor, 0, 0)[0].segments).toEqual(['왼쪽', '오른쪽', '다음 줄'])
    applyRunTranslation(editor, 0, ['Left', 'Right', 'Next line'])
    const after = blockJson(editor, 0)
    expect(texts(after)).toEqual(['Left\tRight', 'Next line'])
    expect(after.content?.[1].type).toBe('hardBreak')
  })

  it('with tracking on, the old run text is struck through and the new text follows with the same style', async () => {
    const editor = await createEditor([mixedParagraph])
    applyRunTranslation(editor, 0, ['First sentence', 'italic', 'red end.'], { track: TRACK })
    const after = blockJson(editor, 0)
    const runs = (after.content ?? []).filter((c) => c.type === 'text')
    const style = (c: PmNode) => c.marks?.find((m) => m.type === 'docTextStyle')?.attrs
    const has = (c: PmNode, t: string) => c.marks?.some((m) => m.type === t)
    expect(runs.filter((c) => has(c, 'del')).map((c) => c.text)).toEqual([
      '첫째 문장',
      '기울임',
      '빨간 끝.',
    ])
    const inserted = runs.filter((c) => has(c, 'ins'))
    expect(inserted.map((c) => c.text)).toEqual(['First sentence', 'italic', 'red end.'])
    expect(inserted.map(style)).toEqual(
      [STYLE_A, STYLE_B, STYLE_C].map((s) => expect.objectContaining(s)),
    )
  })
})

describe('read_runs / translate_blocks tools', () => {
  it('translate_blocks edits several blocks in one undoable step and reports incomplete ones', async () => {
    const editor = await createEditor([mixedParagraph, emptyParagraph, mixedParagraph])
    const read = await executeTool(
      editor,
      { id: 'r', name: 'read_runs', input: { startBlockIndex: 0, endBlockIndex: 2 } },
      NUM_IDS,
    )
    expect(read.isError).toBeFalsy()
    expect(read.output).toContain('"empty":true')
    const docBefore = editor.state.doc
    const exec = await executeTool(
      editor,
      {
        id: 't',
        name: 'translate_blocks',
        input: {
          blocks: [
            { index: 0, segments: ['A', 'B', 'C'] },
            { index: 2, segments: ['only one'] },
          ],
        },
      },
      NUM_IDS,
    )
    expect(exec.isError).toBeFalsy()
    expect(exec.mutated).toBe(true)
    expect(exec.output).toMatch(/block 2.*1 of 3/i)
    expect(texts(blockJson(editor, 0))).toEqual(['A ', 'B', ' C'])
    expect(editor.state.doc.childCount).toBe(docBefore.childCount)
    editor.commands.undo()
    expect(editor.state.doc.eq(docBefore)).toBe(true)
  })

  it('translate_blocks refuses a bad index without touching the document', async () => {
    const editor = await createEditor([mixedParagraph])
    const before = editor.state.doc
    const exec = await executeTool(
      editor,
      { id: 't', name: 'translate_blocks', input: { blocks: [{ index: 9, segments: ['x'] }] } },
      NUM_IDS,
    )
    expect(exec.isError).toBe(true)
    expect(editor.state.doc).toBe(before)
  })
})
