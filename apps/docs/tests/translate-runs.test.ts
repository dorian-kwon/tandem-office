import { applyAiPanelPrefs } from '@genoffice/ui'
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { BLANK_BULLET_NUM_ID, BLANK_ORDERED_NUM_ID } from '@genoffice/docx-engine'
import type { PmNode } from '../src/renderer/editor/convert'
import {
  applyRunTranslation,
  remainingUntranslated,
  readRunGroups,
  runFingerprint,
  TAG_LIKE,
} from '../src/renderer/ai/translate-runs'
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
const MIXED = ['첫째 문장 ', '기울임', ' 빨간 끝.']
const FP = runFingerprint(MIXED)
const emptyParagraph: PmNode = {
  type: 'docParagraph',
  attrs: { styleId: 'BlankLine', docxIndex: 4 },
}

const liveEditors: Editor[] = []
afterEach(() => {
  applyAiPanelPrefs({})
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
      { index: 0, fp: runFingerprint(MIXED), segments: MIXED },
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
      {
        index: 0,
        fp: runFingerprint(['살아 있는 글', '뒤의 글']),
        segments: ['살아 있는 글', '뒤의 글'],
      },
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
      {
        index: 0,
        paragraph: 0,
        cell: 'r0c0',
        fp: runFingerprint(['칸 하나']),
        segments: ['칸 하나'],
      },
      { index: 0, paragraph: 1, cell: 'r0c1', fp: runFingerprint(['칸 둘']), segments: ['칸 둘'] },
    ])
  })
})

it('resumes a same-script translation using the applied result at each address', async () => {
  const original = 'Доброе утро'
  const editor = await createEditor(
    [0, 1].map(() => ({
      type: 'docParagraph',
      content: [{ type: 'text', text: original }],
    })),
  )
  const pending = () => remainingUntranslated(editor, undefined, 'ru').body
  expect(pending()).toEqual(['0', '1'])
  const outcome = await executeTool(
    editor,
    {
      id: 'translate',
      name: 'translate_blocks',
      input: {
        blocks: [{ index: 0, fp: runFingerprint([original]), segments: ['Доброго ранку'] }],
      },
    },
    NUM_IDS,
  )
  expect(outcome.isError).toBeFalsy()
  expect(pending()).toEqual(['1'])
  editor.commands.undo()
  expect(pending()).toEqual(['0', '1'])
  editor.commands.redo()
  expect(pending()).toEqual(['1'])
  editor.view.dispatch(editor.state.tr.insertText('!', 2))
  expect(pending()).toEqual(['0', '1'])
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
  it('translate_blocks edits several blocks with independent undo and reports incomplete ones', async () => {
    applyAiPanelPrefs({ aiEditUndoHistory: true })
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
            { index: 0, fp: FP, segments: ['A', 'B', 'C'] },
            { index: 2, fp: FP, segments: ['only one'] },
          ],
        },
      },
      NUM_IDS,
    )
    expect(exec.isError).toBeFalsy()
    expect(exec.mutated).toBe(true)
    expect(exec.changeLocations).toEqual([
      { kind: 'block', index: 0, token: expect.any(Number) },
      { kind: 'block', index: 2, token: expect.any(Number) },
    ])
    expect(exec.output).toMatch(/block 2.*1 of 3/i)
    expect(texts(blockJson(editor, 0))).toEqual(['A ', 'B', ' C'])
    expect(editor.state.doc.childCount).toBe(docBefore.childCount)
    editor.commands.undo()
    expect(editor.state.doc.child(2).eq(docBefore.child(2))).toBe(true)
    expect(editor.state.doc.child(0).eq(docBefore.child(0))).toBe(false)
    editor.commands.undo()
    expect(editor.state.doc.eq(docBefore)).toBe(true)
  })

  it('translate_blocks refuses a bad index without touching the document', async () => {
    const editor = await createEditor([mixedParagraph])
    const before = editor.state.doc
    const exec = await executeTool(
      editor,
      {
        id: 't',
        name: 'translate_blocks',
        input: { blocks: [{ index: 9, fp: FP, segments: ['x'] }] },
      },
      NUM_IDS,
    )
    expect(exec.isError).toBe(true)
    expect(editor.state.doc).toBe(before)
  })
})

describe('translate_blocks refuses unsafe input (review fixes)', () => {
  const call = (blocks: unknown[]) => ({ id: 't', name: 'translate_blocks', input: { blocks } })

  async function refused(editor: Editor, blocks: unknown[], message: RegExp) {
    const before = editor.state.doc
    const exec = await executeTool(editor, call(blocks), NUM_IDS)
    expect(exec.isError).toBe(true)
    expect(exec.output).toMatch(message)
    expect(editor.state.doc).toBe(before)
  }

  it('an all-empty segment list never deletes a paragraph; one empty piece among others is allowed', async () => {
    const editor = await createEditor([mixedParagraph, mixedParagraph])
    await refused(editor, [{ index: 0, fp: FP, segments: [''] }], /every segment is empty/)
    await refused(editor, [{ index: 0, fp: FP, segments: [' ', '', ''] }], /every segment is empty/)
    // the bad item refuses the whole call, the good one included
    await refused(
      editor,
      [
        { index: 1, fp: FP, segments: ['A', 'B', 'C'] },
        { index: 0, fp: FP, segments: [''] },
      ],
      /every segment is empty/,
    )
    expect(applyRunTranslation(editor, 0, [''], {}).ok).toBe(false)
    const exec = await executeTool(
      editor,
      call([{ index: 0, fp: FP, segments: ['A', '', 'C'] }]),
      NUM_IDS,
    )
    expect(exec.isError).toBeFalsy()
    expect(texts(blockJson(editor, 0))).toEqual(['A ', 'C'])
  })

  it('a table entry without paragraph is refused when the table has several cell paragraphs', async () => {
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
    await refused(
      editor,
      [{ index: 0, fp: runFingerprint(['칸 하나']), segments: ['one'] }],
      /needs "paragraph"/,
    )
    const exec = await executeTool(
      editor,
      call([
        { index: 0, paragraph: 1, cell: 'r0c1', fp: runFingerprint(['칸 둘']), segments: ['two'] },
      ]),
      NUM_IDS,
    )
    expect(exec.isError).toBeFalsy()
  })

  it('a missing or stale fingerprint is refused, so a shifted index cannot hit the wrong paragraph', async () => {
    const other: PmNode = { type: 'docParagraph', attrs: {}, content: [text('다른 문단', STYLE_A)] }
    const editor = await createEditor([mixedParagraph, other])
    await refused(editor, [{ index: 0, segments: ['A', 'B', 'C'] }], /fp is missing/)
    // the model read block 0, then the paragraphs shifted: block 0 is now another paragraph
    editor.view.dispatch(editor.state.tr.insert(0, editor.schema.nodeFromJSON(other)))
    await refused(
      editor,
      [{ index: 0, fp: FP, segments: ['A', 'B', 'C'] }],
      /block 0 changed since read_runs/,
    )
    const fresh = readRunGroups(editor, 1, 1)[0]
    const exec = await executeTool(
      editor,
      call([{ index: 1, fp: fresh.fp, segments: ['A', 'B', 'C'] }]),
      NUM_IDS,
    )
    expect(exec.isError).toBeFalsy()
  })

  it('angle-bracketed titles and comparisons are prose; real markup is refused', async () => {
    for (const prose of [
      '<Clear Bamboo>',
      '<청죽(晴竹)>',
      '1 < 2',
      '<Title of Book>',
      'a <bamboo> b',
      'x<y and y>z',
    ])
      expect(TAG_LIKE.test(prose), prose).toBe(false)
    for (const markup of [
      '<b>x</b>',
      '<script>',
      '</p>',
      '<br/>',
      '<span class="x">a</span>',
      '<w:t>a</w:t>',
      '<em >a',
    ])
      expect(TAG_LIKE.test(markup), markup).toBe(true)
    const editor = await createEditor([mixedParagraph])
    const exec = await executeTool(
      editor,
      call([{ index: 0, fp: FP, segments: ['<Clear Bamboo>', '<청죽(晴竹)>', '1 < 2'] }]),
      NUM_IDS,
    )
    expect(exec.isError).toBeFalsy()
    expect(texts(blockJson(editor, 0))).toEqual(['<Clear Bamboo> ', '<청죽(晴竹)>', ' 1 < 2'])
    await refused(
      editor,
      [
        {
          index: 0,
          fp: runFingerprint(['<Clear Bamboo> ', '<청죽(晴竹)>', ' 1 < 2']),
          segments: ['<script>x', 'B', 'C'],
        },
      ],
      /HTML-like tags/,
    )
  })

  it('segments with a line break or HTML-like tags are refused', async () => {
    const editor = await createEditor([mixedParagraph])
    await refused(editor, [{ index: 0, fp: FP, segments: ['A\nB', 'B', 'C'] }], /line break/)
    await refused(
      editor,
      [{ index: 0, fp: FP, segments: ['<em>A</em>', 'B', 'C'] }],
      /HTML-like tags/,
    )
    await refused(editor, [{ index: 0, fp: FP, segments: ['A<br/>', 'B', 'C'] }], /HTML-like tags/)
    // a lone angle bracket in prose is still text
    const exec = await executeTool(
      editor,
      call([{ index: 0, fp: FP, segments: ['1 < 2', 'B', 'C'] }]),
      NUM_IDS,
    )
    expect(exec.isError).toBeFalsy()
  })
})

describe('the system prompt and tool descriptions agree on how to translate', () => {
  it('every mention of translation points at read_runs / translate_blocks, never at replace_blocks', async () => {
    const { AGENT_SYSTEM_PROMPT } = await import('../src/renderer/ai/protocol')
    const { AGENT_TOOLS } = await import('../src/renderer/ai/tools')
    const texts = [
      ...AGENT_SYSTEM_PROMPT.split('\n'),
      ...AGENT_TOOLS.map((tool) => `${tool.name}: ${tool.description}`),
    ]
    const mentions = texts.filter((line) => /translat/i.test(line))
    expect(mentions.some((line) => /read_runs[^\n]*translate_blocks/.test(line))).toBe(true)
    // a line that brings up both translation and replace_blocks must route translation to translate_blocks
    for (const line of mentions.filter((l) => l.includes('replace_blocks')))
      expect(line, line).toContain('translate_blocks')
    // the table rule: table text is translated cell paragraph by cell paragraph
    const tableRule = texts.find(
      (line) => line.includes('to change table content') || line.includes('table content'),
    )
    expect(tableRule).toMatch(/translate_blocks/)
  })
})
