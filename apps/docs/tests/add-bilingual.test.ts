import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { TableMap } from '@tiptap/pm/tables'
import { BLANK_BULLET_NUM_ID, BLANK_ORDERED_NUM_ID } from '@genoffice/docx-engine'
import type { PmNode } from '../src/renderer/editor/convert'
import { applyBilingual } from '../src/renderer/ai/bilingual-runs'
import {
  readRunGroups,
  remainingUntranslated,
  runFingerprint,
} from '../src/renderer/ai/translate-runs'
import { executeTool } from '../src/renderer/ai/tools'

/**
 * add_bilingual: the original stays, its translation is added next to it (a
 * paragraph after it, or a new column / row in a table). Constructed documents,
 * the real schema.
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
  attrs: { styleId: 'af5', indentFirstLine: 200, docxIndex: 3 },
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
const plain = (t: string, docxIndex = 5): PmNode => ({
  type: 'docParagraph',
  attrs: { docxIndex },
  content: [text(t, STYLE_A)],
})

const cell = (t: string, attrs: Record<string, unknown> = {}): PmNode => ({
  type: 'docTableCell',
  attrs: { colwidth: [100], ...attrs },
  content: [{ type: 'docParagraph', attrs: {}, content: [text(t, STYLE_A)] }],
})
const row = (...cells: PmNode[]): PmNode => ({ type: 'docTableRow', content: cells })
const table = (...rows: PmNode[]): PmNode => ({
  type: 'docTable',
  attrs: { docxIndex: 7 },
  content: rows,
})

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
  editor.view.dispatch(
    editor.state.tr
      .replaceWith(0, editor.state.doc.content.size, pm)
      .setMeta('addToHistory', false),
  )
  return editor
}

const blockJson = (editor: Editor, i: number): PmNode =>
  ((editor.getJSON() as PmNode).content ?? [])[i]
const texts = (node: PmNode): string[] =>
  (node.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '')
const cellTexts = (node: PmNode): string[][] =>
  (node.content ?? []).map((r) =>
    (r.content ?? []).map((c) =>
      (c.content ?? []).map((p) => (p.content ?? []).map((t) => t.text ?? '').join('')).join('\n'),
    ),
  )
const fp = (t: string) => runFingerprint([t])
const item = (index: number, t: string, segments: string[], paragraph?: number) => ({
  index,
  fp: fp(t),
  segments,
  ...(paragraph === undefined ? {} : { paragraph }),
})
const call = (input: Record<string, unknown>) => ({ id: 'b', name: 'add_bilingual', input })

/** a 2 x 2 table of text cells, every paragraph with its translation */
const grid = () =>
  table(
    row(cell('가', { fill: 'FFEEDD' }), cell('나')),
    row(cell('다', { fill: 'FFEEDD' }), cell('라')),
  )
const gridItems = () => [
  item(0, '가', ['A'], 0),
  item(0, '나', ['B'], 1),
  item(0, '다', ['C'], 2),
  item(0, '라', ['D'], 3),
]

describe('add_bilingual: body paragraphs', () => {
  it('adds a twin after the original with the same style and per-run marks; the original and empty paragraphs are untouched', async () => {
    const editor = await createEditor([mixedParagraph, emptyParagraph, plain('끝')])
    const before = editor.getJSON() as PmNode
    const out = applyBilingual(editor, 'after', [
      { index: 0, fp: FP, segments: ['First sentence', 'italic', 'red end.'] },
    ])
    expect(out.ok).toBe(true)
    const doc = editor.getJSON() as PmNode
    expect(doc.content).toHaveLength(4)
    expect(doc.content![0]).toEqual(before.content![0])
    expect(doc.content![2]).toEqual(before.content![1])
    expect(doc.content![3]).toEqual(before.content![2])
    const twin = doc.content![1]
    expect(twin.type).toBe('docParagraph')
    expect(twin.attrs).toEqual(
      expect.objectContaining({ styleId: 'af5', indentFirstLine: 200, docxIndex: null }),
    )
    expect(texts(twin).join('')).toBe('First sentence italic red end.')
    expect(twin.content!.some((c) => c.type === 'docNoteRef')).toBe(false)
    const styles = twin.content!.map((c) => c.marks?.find((m) => m.type === 'docTextStyle')?.attrs)
    expect(styles).toEqual([STYLE_A, STYLE_B, STYLE_C].map((s) => expect.objectContaining(s)))
  })

  it('a heading twin stays a heading and a list item twin becomes a paragraph at the text indent', async () => {
    const editor = await createEditor([
      {
        type: 'docHeading',
        attrs: { level: 2, styleId: 'Heading2' },
        content: [text('제목', STYLE_A)],
      },
      {
        type: 'docListItem',
        attrs: { kind: 'bullet', numId: '3', ilvl: 1, indentLeft: 1200 },
        content: [text('항목', STYLE_A)],
      },
    ])
    expect(
      applyBilingual(editor, 'after', [item(0, '제목', ['Title']), item(1, '항목', ['Item'])]).ok,
    ).toBe(true)
    expect(blockJson(editor, 1).type).toBe('docHeading')
    expect(blockJson(editor, 1).attrs).toEqual(
      expect.objectContaining({ level: 2, styleId: 'Heading2' }),
    )
    expect(blockJson(editor, 3).type).toBe('docParagraph')
    expect(blockJson(editor, 3).attrs).toEqual(expect.objectContaining({ indentLeft: 1200 }))
    expect(blockJson(editor, 2).type).toBe('docListItem')
  })

  it('undo removes the last twin first and redo restores each twin', async () => {
    const editor = await createEditor([plain('가'), plain('나')])
    const before = editor.state.doc
    applyBilingual(editor, 'after', [item(0, '가', ['A']), item(1, '나', ['B'])])
    expect(editor.state.doc.childCount).toBe(4)
    editor.commands.undo()
    expect(editor.state.doc.textContent).toBe('가A나')
    editor.commands.undo()
    expect(editor.state.doc.eq(before)).toBe(true)
    editor.commands.redo()
    expect(editor.state.doc.textContent).toBe('가A나')
    editor.commands.redo()
    expect(editor.state.doc.textContent).toBe('가A나B')
  })

  it('refuses a stale fingerprint and an incomplete segment list without touching the document', async () => {
    const editor = await createEditor([mixedParagraph])
    const before = editor.state.doc
    const stale = applyBilingual(editor, 'after', [
      { index: 0, fp: 'nope', segments: ['a', 'b', 'c'] },
    ])
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.errors.join()).toMatch(/fingerprint mismatch/)
    const short = applyBilingual(editor, 'after', [{ index: 0, fp: FP, segments: ['only'] }])
    expect(short.ok).toBe(false)
    expect(editor.state.doc).toBe(before)
  })

  it('a paragraph with a twin is not offered or added again; the twin is never a target', async () => {
    const editor = await createEditor([plain('가'), plain('나')])
    applyBilingual(editor, 'after', [item(0, '가', ['A'])])
    const read = readRunGroups(editor, 0, 2)
    expect(read[0].skip).toMatch(/already has its bilingual/)
    expect(read[1].skip).toMatch(/bilingual translation added/)
    expect(read[2].segments).toEqual(['나'])
    const doc = editor.state.doc
    const again = applyBilingual(editor, 'after', [item(0, '가', ['A'])])
    expect(again.ok && again.alreadyDone).toEqual(['block 0'])
    expect(editor.state.doc).toBe(doc)
    const twin = applyBilingual(editor, 'after', [item(1, 'A', ['x'])])
    expect(twin.ok).toBe(false)
  })

  it('counts the source of each completed bilingual pair only if it belongs to the translation', async () => {
    const editor = await createEditor([plain('서울'), plain('English'), plain('123')])
    expect(
      applyBilingual(editor, 'after', [item(0, '서울', ['Seoul']), item(1, 'English', ['EN'])]).ok,
    ).toBe(true)
    expect(remainingUntranslated(editor, undefined, 'ko').progress).toEqual({ done: 1, total: 1 })
    expect(remainingUntranslated(editor, undefined, 'fr').progress).toEqual({ done: 1, total: 1 })
  })

  it('resumes only the unpaired duplicate after a manual edit of the first translation', async () => {
    const editor = await createEditor([plain('동일'), plain('동일')])
    expect(applyBilingual(editor, 'after', [item(0, '동일', ['Same'])]).ok).toBe(true)
    const twinStart = editor.state.doc.child(0).nodeSize + 1
    editor.view.dispatch(editor.state.tr.insertText('Revised', twinStart, twinStart + 4))
    const mark = editor.schema.marks.docTextStyle!.create(STYLE_C)
    editor.view.dispatch(editor.state.tr.addMark(twinStart, twinStart + 3, mark))
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(0, undefined, {
        ...editor.state.doc.child(0).attrs,
        styleId: 'Edited source style',
      }),
    )
    const left = () => remainingUntranslated(editor, undefined, 'ko').body
    expect(remainingUntranslated(editor, undefined, 'ko').progress).toEqual({ done: 1, total: 2 })
    expect(left()).toEqual(['2'])
    expect(readRunGroups(editor, 0, 2)[1]?.skip).toMatch(/translation added/)
    readRunGroups(editor, 0, 2)
    expect(applyBilingual(editor, 'after', [item(2, '동일', ['Same'])]).ok).toBe(true)
    expect(left()).toEqual([])
    editor.commands.undo()
    expect(left()).toEqual(['2'])
    expect(editor.state.doc.child(1).textContent).toBe('Revised')
    editor.commands.redo()
    expect(left()).toEqual([])
  })

  it('a second call from the same read still finds its paragraph after earlier insertions', async () => {
    const editor = await createEditor([plain('가'), plain('나'), plain('다')])
    expect(applyBilingual(editor, 'after', [item(0, '가', ['A'])]).ok).toBe(true)
    const out = applyBilingual(editor, 'after', [item(1, '나', ['B']), item(2, '다', ['C'])])
    expect(out.ok).toBe(true)
    const doc = editor.getJSON() as PmNode
    expect(doc.content!.map((b) => texts(b).join(''))).toEqual(['가', 'A', '나', 'B', '다', 'C'])
  })

  it('completion check: neither side of a pair is listed as untranslated', async () => {
    const editor = await createEditor([plain('가'), plain('나')])
    expect(remainingUntranslated(editor, undefined, 'ko').body).toEqual(['0', '1'])
    const result = await executeTool(
      editor,
      call({ layout: 'after', blocks: [item(0, '가', ['A']), item(1, '나', ['B'])] }),
      NUM_IDS,
    )
    expect(result.isError).toBeFalsy()
    expect(result.mutated).toBe(true)
    expect(remainingUntranslated(editor, undefined, 'ko').body).toEqual([])
    expect(remainingUntranslated(editor, undefined).body).toEqual([])
    const check = await executeTool(
      editor,
      { id: 'c', name: 'read_runs', input: { checkRemaining: true, sourceLanguage: 'ko' } },
      NUM_IDS,
    )
    expect(check.output).toMatch(/Nothing left/)
  })

  it('layout "right" or "below" on a body paragraph still adds a paragraph after it; "after" on a table is refused', async () => {
    const editor = await createEditor([plain('가'), grid()])
    const refused = applyBilingual(editor, 'after', [item(1, '가', ['A'], 0)])
    expect(refused.ok).toBe(false)
    expect(applyBilingual(editor, 'below', [item(0, '가', ['A'])]).ok).toBe(true)
    expect(editor.state.doc.child(1).type.name).toBe('docParagraph')
    expect(editor.state.doc.child(2).type.name).toBe('docTable')
  })

  it('with tracking on, the twin text is an insertion and the original is not marked', async () => {
    const editor = await createEditor([mixedParagraph])
    applyBilingual(editor, 'after', [{ index: 0, fp: FP, segments: ['A', 'B', 'C'] }], TRACK)
    const marks = (i: number) =>
      (blockJson(editor, i).content ?? []).flatMap((c) => (c.marks ?? []).map((m) => m.type))
    expect(marks(0)).not.toContain('ins')
    const twinMarks = (blockJson(editor, 1).content ?? []).map((c) =>
      (c.marks ?? []).map((m) => m.type),
    )
    expect(twinMarks.every((m) => m.includes('ins'))).toBe(true)
  })
})

describe('add_bilingual: tables', () => {
  it('right: a new column beside each text column; originals untouched, formatting and widths copied', async () => {
    const editor = await createEditor([grid()])
    const original = cellTexts(blockJson(editor, 0))
    const out = applyBilingual(editor, 'right', gridItems())
    expect(out.ok && out.tables[0]).toEqual(
      expect.objectContaining({ layout: 'right', paragraphs: 4 }),
    )
    const json = blockJson(editor, 0)
    expect(cellTexts(json)).toEqual([
      ['가', 'A', '나', 'B'],
      ['다', 'C', '라', 'D'],
    ])
    expect(original).toEqual([
      ['가', '나'],
      ['다', '라'],
    ])
    const firstRow = json.content![0].content!
    expect(firstRow.map((c) => c.attrs?.fill ?? null)).toEqual(['FFEEDD', 'FFEEDD', null, null])
    // each twin column shares its original's width: the table keeps its total
    expect(firstRow.map((c) => (c.attrs?.colwidth as number[])[0])).toEqual([50, 50, 50, 50])
    const map = TableMap.get(editor.state.doc.child(0))
    expect(map.problems).toBeNull()
    expect(map.width).toBe(4)
  })

  it('right: a column without text gets no twin column', async () => {
    const editor = await createEditor([
      table(row(cell('1'), cell('가')), row(cell('2'), cell('나'))),
    ])
    const out = applyBilingual(editor, 'right', [item(0, '가', ['A'], 1), item(0, '나', ['B'], 3)])
    expect(out.ok).toBe(true)
    expect(cellTexts(blockJson(editor, 0))).toEqual([
      ['1', '가', 'A'],
      ['2', '나', 'B'],
    ])
  })

  it('below: a new row under each text row; originals untouched', async () => {
    const editor = await createEditor([grid()])
    const out = applyBilingual(editor, 'below', gridItems())
    expect(out.ok && out.tables[0]).toEqual(expect.objectContaining({ layout: 'below' }))
    const json = blockJson(editor, 0)
    expect(cellTexts(json)).toEqual([
      ['가', '나'],
      ['A', 'B'],
      ['다', '라'],
      ['C', 'D'],
    ])
    expect(json.content!.map((r) => r.content![0].attrs?.fill ?? null)).toEqual([
      'FFEEDD',
      'FFEEDD',
      'FFEEDD',
      'FFEEDD',
    ])
    expect(TableMap.get(editor.state.doc.child(0)).problems).toBeNull()
  })

  it('merged cells: right falls back to below, mirrors the spans and says so', async () => {
    const editor = await createEditor([
      table(row(cell('제목', { colspan: 2, colwidth: [100, 100] })), row(cell('가'), cell('나'))),
    ])
    const result = await executeTool(
      editor,
      call({
        layout: 'right',
        blocks: [item(0, '제목', ['Title'], 0), item(0, '가', ['A'], 1), item(0, '나', ['B'], 2)],
      }),
      NUM_IDS,
    )
    expect(result.isError).toBeFalsy()
    expect(result.output).toMatch(/FELL BACK from "right" to "below" because it has merged cells/)
    const json = blockJson(editor, 0)
    expect(cellTexts(json)).toEqual([['제목'], ['Title'], ['가', '나'], ['A', 'B']])
    expect(json.content![1].content![0].attrs?.colspan).toBe(2)
    const map = TableMap.get(editor.state.doc.child(0))
    expect(map.problems).toBeNull()
    expect([map.width, map.height]).toEqual([2, 4])
  })

  it('vertically merged rows are repeated as one block after the group', async () => {
    const editor = await createEditor([
      table(row(cell('가', { rowspan: 2 }), cell('나')), row(cell('다'))),
    ])
    const out = applyBilingual(editor, 'below', [
      item(0, '가', ['A'], 0),
      item(0, '나', ['B'], 1),
      item(0, '다', ['C'], 2),
    ])
    expect(out.ok && out.tables[0].blockwise).toBe('it has merged cells')
    expect(cellTexts(blockJson(editor, 0))).toEqual([['가', '나'], ['다'], ['A', 'B'], ['C']])
    const map = TableMap.get(editor.state.doc.child(0))
    expect(map.problems).toBeNull()
    expect([map.width, map.height]).toEqual([2, 4])
    expect(blockJson(editor, 0).content![2].content![0].attrs?.rowspan).toBe(2)
    const final = editor.state.doc
    expect(editor.commands.undo()).toBe(true)
    const pending = readRunGroups(editor, 0, 0).filter((entry) => entry.fp)
    expect(pending.map((entry) => entry.segments)).toEqual([['다']])
    const restored = applyBilingual(editor, 'below', [item(0, '다', ['C'], pending[0].paragraph)])
    expect(restored.ok && restored.tables[0].paragraphs).toBe(1)
    expect(editor.state.doc.eq(final)).toBe(true)
  })

  it('a table must come whole: missing paragraphs refuse the call', async () => {
    const editor = await createEditor([grid()])
    const before = editor.state.doc
    const out = applyBilingual(editor, 'right', gridItems().slice(0, 2))
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.errors.join()).toMatch(/whole table.*paragraph 2, 3/)
    expect(editor.state.doc).toBe(before)
  })

  it('a table item needs its paragraph number; a bad fingerprint refuses everything', async () => {
    const editor = await createEditor([grid()])
    const noNumber = applyBilingual(editor, 'right', [item(0, '가', ['A'])])
    expect(noNumber.ok).toBe(false)
    const items = gridItems()
    items[3] = { ...items[3], fp: 'stale' }
    const before = editor.state.doc
    const stale = applyBilingual(editor, 'right', items)
    expect(stale.ok).toBe(false)
    expect(editor.state.doc).toBe(before)
  })

  it('a table that has its twins is skipped the second time and its read_runs entries are skipped', async () => {
    const editor = await createEditor([grid()])
    applyBilingual(editor, 'below', gridItems())
    const read = readRunGroups(editor, 0, 0)
    expect(read.every((r) => r.skip !== undefined)).toBe(true)
    const doc = editor.state.doc
    const again = applyBilingual(editor, 'below', gridItems())
    expect(again.ok && again.alreadyDone).toEqual(['block 0 (table)'])
    expect(editor.state.doc).toBe(doc)
    expect(remainingUntranslated(editor, undefined, 'ko').body).toEqual([])
  })

  it('body paragraphs and table cells are independently undoable after one call', async () => {
    const editor = await createEditor([plain('앞'), grid(), plain('뒤')])
    const before = editor.state.doc
    const out = applyBilingual(editor, 'below', [
      item(0, '앞', ['Front']),
      ...gridItems().map((i) => ({ ...i, index: 1 })),
      item(2, '뒤', ['Back']),
    ])
    expect(out.ok).toBe(true)
    const doc = editor.getJSON() as PmNode
    expect(doc.content!.map((b) => b.type)).toEqual([
      'docParagraph',
      'docParagraph',
      'docTable',
      'docParagraph',
      'docParagraph',
    ])
    expect(texts(doc.content![4]).join('')).toBe('Back')
    editor.commands.undo()
    expect(editor.state.doc.textContent).not.toContain('Back')
    for (const _entry of gridItems()) expect(editor.commands.undo()).toBe(true)
    expect(editor.state.doc.child(2).eq(before.child(1))).toBe(true)
    editor.commands.undo()
    expect(editor.state.doc.eq(before)).toBe(true)
  })

  it.each(['right', 'below'] as const)(
    'refills the precise %s slot after undo with identical source and twin text',
    async (layout) => {
      const editor = await createEditor([
        table(row(cell('같음'), cell('같음')), row(cell('같음'), cell('같음'))),
      ])
      const first = Array.from({ length: 4 }, (_, i) => item(0, '같음', ['Twin'], i))
      expect(applyBilingual(editor, layout, first).ok).toBe(true)
      const final = editor.state.doc
      expect(editor.commands.undo()).toBe(true)
      const partial = editor.state.doc
      const pending = readRunGroups(editor, 0, 0).filter((run) => run.fp)
      expect(pending).toHaveLength(1)
      expect(pending[0].segments).toEqual(['같음'])
      const fill = pending.map((run) => ({
        index: 0,
        paragraph: run.paragraph,
        fp: run.fp!,
        segments: ['Twin'],
      }))
      const output = applyBilingual(editor, layout, fill)
      expect(output.ok && output.tables[0].paragraphs).toBe(1)
      expect(editor.state.doc.eq(final)).toBe(true)
      expect(editor.commands.undo()).toBe(true)
      expect(editor.state.doc.eq(partial)).toBe(true)
      expect(editor.commands.redo()).toBe(true)
      expect(editor.state.doc.eq(final)).toBe(true)
    },
  )

  it('refills a skipped nested-table paragraph without duplicating the expanded grid', async () => {
    const content = table(row(cell('바깥')))
    content.content![0].content![0].content!.push({
      type: 'docNestedTable',
      attrs: {
        model: { rows: [[{ paras: ['반복'] }, { paras: ['반복'] }]], colWidths: [1000, 1000] },
      },
    })
    const editor = await createEditor([content])
    const pending = () =>
      readRunGroups(editor, 0, 0)
        .filter((run) => run.nestedTable === 0 && run.fp)
        .map((run) => ({
          index: 0,
          nestedTable: 0,
          paragraph: run.paragraph,
          fp: run.fp!,
          segments: ['Twin'],
        }))
    expect(pending()).toHaveLength(2)
    expect(applyBilingual(editor, 'right', pending()).ok).toBe(true)
    const final = editor.state.doc
    expect(editor.commands.undo()).toBe(true)
    expect(pending()).toHaveLength(1)
    expect(applyBilingual(editor, 'right', pending()).ok).toBe(true)
    expect(editor.state.doc.eq(final)).toBe(true)
  })

  it('with tracking on, new rows and cells are insertions', async () => {
    const editor = await createEditor([grid()])
    applyBilingual(editor, 'below', gridItems(), TRACK)
    const rows = blockJson(editor, 0).content!
    expect(
      rows.map((r) => (r.attrs?.rowRevision as { kind?: string } | null)?.kind ?? null),
    ).toEqual([null, 'ins', null, 'ins'])
    const twinText = rows[1].content![0].content![0].content![0]
    expect(twinText.marks!.map((m) => m.type)).toContain('ins')
    const right = await createEditor([grid()])
    applyBilingual(right, 'right', gridItems(), TRACK)
    const cells = blockJson(right, 0).content![0].content!
    expect(
      cells.map((c) => (c.attrs?.cellRevision as { kind?: string } | null)?.kind ?? null),
    ).toEqual([null, 'ins', null, 'ins'])
  })
})
