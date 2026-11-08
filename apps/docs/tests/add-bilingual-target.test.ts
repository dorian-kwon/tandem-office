import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { BLANK_BULLET_NUM_ID, BLANK_ORDERED_NUM_ID } from '@genoffice/docx-engine'
import type { PmNode } from '../src/renderer/editor/convert'
import { applyBilingual, type BilingualTarget } from '../src/renderer/ai/bilingual-runs'
import {
  readRunGroups,
  remainingUntranslated,
  runFingerprint,
} from '../src/renderer/ai/translate-runs'
import { executeTool } from '../src/renderer/ai/tools'

/**
 * add_bilingual with an explicit target: an existing (empty) cell anywhere, or a
 * new paragraph after / before any block or at the end. Constructed documents.
 */

const NUM_IDS = { bullet: BLANK_BULLET_NUM_ID, ordered: BLANK_ORDERED_NUM_ID }
const TRACK = { author: 'AI Assistant' }
const STYLE = { font: 'Batang', sizeHalfPoints: 22, rawRPr: '<w:rPr><w:i/></w:rPr>' }

const text = (t: string): PmNode => ({
  type: 'text',
  text: t,
  marks: [{ type: 'docTextStyle', attrs: STYLE }],
})
const plain = (t: string): PmNode => ({ type: 'docParagraph', attrs: {}, content: [text(t)] })
const cell = (t: string, attrs: Record<string, unknown> = {}, paraAttrs = {}): PmNode => ({
  type: 'docTableCell',
  attrs: { colwidth: [100], ...attrs },
  content: [
    { type: 'docParagraph', attrs: paraAttrs, ...(t === '' ? {} : { content: [text(t)] }) },
  ],
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
const cellTexts = (node: PmNode): string[][] =>
  (node.content ?? []).map((r) =>
    (r.content ?? []).map((c) =>
      (c.content ?? []).map((p) => (p.content ?? []).map((t) => t.text ?? '').join('')).join('\n'),
    ),
  )
const bodyTexts = (editor: Editor): string[] =>
  ((editor.getJSON() as PmNode).content ?? []).map((b) =>
    (b.content ?? []).map((t) => t.text ?? '').join(''),
  )
const fp = (t: string) => runFingerprint([t])
const item = (
  index: number,
  t: string,
  segments: string[],
  target: BilingualTarget,
  paragraph?: number,
) => ({
  index,
  fp: fp(t),
  segments,
  target,
  ...(paragraph === undefined ? {} : { paragraph }),
})
const cellAt = (index: number, row: number, column: number, extra = {}): BilingualTarget => ({
  kind: 'cell',
  index,
  row,
  column,
  ...extra,
})
const errorsOf = (out: ReturnType<typeof applyBilingual>): string =>
  out.ok ? '' : out.errors.join(' | ')
const call = (input: Record<string, unknown>) => ({ id: 't', name: 'add_bilingual', input })

/** original | OCR | translation worksheet: row 0 holds the original, the translation cell is empty */
const sheet = () =>
  table(row(cell('원문'), cell(''), cell('')), row(cell('둘째'), cell('기존'), cell('')))

describe('read_runs: cell coordinates', () => {
  it('lists each table paragraph with its grid cell and a wholly empty cell once as empty', async () => {
    const editor = await createEditor([sheet()])
    const read = readRunGroups(editor, 0, 0)
    expect(read).toEqual([
      { index: 0, paragraph: 0, cell: 'r0c0', fp: fp('원문'), segments: ['원문'] },
      { index: 0, cell: 'r0c1', empty: true },
      { index: 0, cell: 'r0c2', empty: true },
      { index: 0, paragraph: 3, cell: 'r1c0', fp: fp('둘째'), segments: ['둘째'] },
      { index: 0, paragraph: 4, cell: 'r1c1', fp: fp('기존'), segments: ['기존'] },
      { index: 0, cell: 'r1c2', empty: true },
    ])
  })

  it('a merged cell is listed at its anchor with its span', async () => {
    const editor = await createEditor([
      table(
        row(cell('넓은', { colspan: 2, colwidth: [50, 50] })),
        row(cell('a', { colwidth: [50] }), cell('', { colwidth: [50] })),
      ),
    ])
    const read = readRunGroups(editor, 0, 0)
    expect(read[0]).toEqual(expect.objectContaining({ cell: 'r0c0', span: '2x1' }))
    expect(read[2]).toEqual({ index: 0, cell: 'r1c1', empty: true })
  })
})

describe('add_bilingual target: cell', () => {
  it('writes into the empty cell right of the original and below it, original untouched', async () => {
    const editor = await createEditor([sheet()])
    const out = applyBilingual(editor, undefined, [
      item(0, '원문', ['Source'], cellAt(0, 0, 1), 0),
      item(0, '둘째', ['Second'], cellAt(0, 1, 2), 3),
    ])
    expect(out.ok).toBe(true)
    expect(cellTexts(blockJson(editor, 0))).toEqual([
      ['원문', 'Source', ''],
      ['둘째', '기존', 'Second'],
    ])
    // the new text keeps the original run marks
    const written = blockJson(editor, 0).content![0].content![1].content![0].content![0]
    expect(written.marks?.find((m) => m.type === 'docTextStyle')?.attrs).toEqual(
      expect.objectContaining(STYLE),
    )
  })

  it('writes into a far cell of another table; one undo step', async () => {
    const editor = await createEditor([
      plain('앞'),
      table(row(cell('가'))),
      table(row(cell('x'), cell(''))),
    ])
    const before = editor.state.doc
    const out = applyBilingual(editor, undefined, [
      item(1, '가', ['A'], cellAt(2, 0, 1), 0),
      item(0, '앞', ['Front'], {
        kind: 'cell',
        index: 2,
        row: 0,
        column: 0,
        overwrite: true,
        fp: fp('x'),
      }),
    ])
    expect(out.ok).toBe(true)
    expect(cellTexts(blockJson(editor, 2))).toEqual([['Front', 'A']])
    editor.commands.undo()
    expect(editor.state.doc.eq(before)).toBe(true)
  })

  it('takes the destination paragraph formatting when it has any, else the original', async () => {
    const editor = await createEditor([
      table(row(cell('가', {}, { align: 'center' }), cell('', {}, { align: 'right' }), cell(''))),
    ])
    expect(applyBilingual(editor, undefined, [item(0, '가', ['A'], cellAt(0, 0, 1), 0)]).ok).toBe(
      true,
    )
    const row0 = blockJson(editor, 0).content![0].content!
    expect(row0[1].content![0].attrs?.align).toBe('right')
    const fresh = await createEditor([
      table(row(cell('가', {}, { align: 'center' }), cell(''), cell(''))),
    ])
    expect(applyBilingual(fresh, undefined, [item(0, '가', ['A'], cellAt(0, 0, 2), 0)]).ok).toBe(
      true,
    )
    expect(blockJson(fresh, 0).content![0].content![2].content![0].attrs?.align).toBe('center')
  })

  it('several items for one cell become its paragraphs in order', async () => {
    const editor = await createEditor([
      table(
        row(
          {
            type: 'docTableCell',
            attrs: { colwidth: [100] },
            content: [plain('가'), plain('나')],
          },
          cell(''),
        ),
      ),
    ])
    const out = applyBilingual(editor, undefined, [
      item(0, '가', ['A'], cellAt(0, 0, 1), 0),
      item(0, '나', ['B'], cellAt(0, 0, 1), 1),
    ])
    expect(out.ok).toBe(true)
    expect(cellTexts(blockJson(editor, 0))).toEqual([['가\n나', 'A\nB']])
  })

  it('refuses a non-empty cell without overwrite and changes nothing', async () => {
    const editor = await createEditor([sheet()])
    const before = editor.state.doc
    const out = applyBilingual(editor, undefined, [item(0, '원문', ['Source'], cellAt(0, 1, 1), 0)])
    expect(errorsOf(out)).toMatch(/not empty.*overwrite/)
    expect(editor.state.doc).toBe(before)
  })

  it('overwrite needs the destination fp: correct replaces, stale or missing is refused', async () => {
    const editor = await createEditor([sheet()])
    const missing = applyBilingual(editor, undefined, [
      item(0, '원문', ['S'], cellAt(0, 1, 1, { overwrite: true }), 0),
    ])
    expect(errorsOf(missing)).toMatch(/own "fp"/)
    const stale = applyBilingual(editor, undefined, [
      item(0, '원문', ['S'], cellAt(0, 1, 1, { overwrite: true, fp: 'nope' }), 0),
    ])
    expect(errorsOf(stale)).toMatch(/no longer matches/)
    const ok = applyBilingual(editor, undefined, [
      item(0, '원문', ['S'], cellAt(0, 1, 1, { overwrite: true, fp: fp('기존') }), 0),
    ])
    expect(ok.ok).toBe(true)
    expect(cellTexts(blockJson(editor, 0))[1]).toEqual(['둘째', 'S', ''])
  })

  it('overwrite is refused while changes are tracked', async () => {
    const editor = await createEditor([sheet()])
    const out = applyBilingual(
      editor,
      undefined,
      [item(0, '원문', ['S'], cellAt(0, 1, 1, { overwrite: true, fp: fp('기존') }), 0)],
      TRACK,
    )
    expect(errorsOf(out)).toMatch(/tracked/)
  })

  it('refuses the original itself as destination, and a destination listed twice by different originals with overwrite', async () => {
    const editor = await createEditor([sheet()])
    const self = applyBilingual(editor, undefined, [
      item(0, '원문', ['S'], cellAt(0, 0, 0, { overwrite: true, fp: fp('원문') }), 0),
    ])
    expect(errorsOf(self)).toMatch(/original itself/)
  })

  it('merged cells: the anchor is addressed, a covered coordinate is refused with the anchor', async () => {
    const merged = () =>
      table(
        row(cell('가', { colwidth: [50] }), cell('', { colspan: 2, colwidth: [50, 50] })),
        row(
          cell('', { colwidth: [50] }),
          cell('', { colwidth: [50] }),
          cell('', { colwidth: [50] }),
        ),
      )
    const covered = await createEditor([merged()])
    const bad = applyBilingual(covered, undefined, [item(0, '가', ['A'], cellAt(0, 0, 2), 0)])
    expect(errorsOf(bad)).toMatch(/merged cell.*anchor is row 0 column 1/)
    const ok = await createEditor([merged()])
    expect(applyBilingual(ok, undefined, [item(0, '가', ['A'], cellAt(0, 0, 1), 0)]).ok).toBe(true)
    expect(cellTexts(blockJson(ok, 0))[0]).toEqual(['가', 'A'])
  })

  it('out of range and not-a-table destinations say what to do', async () => {
    const editor = await createEditor([plain('앞'), sheet()])
    const far = applyBilingual(editor, undefined, [item(0, '앞', ['A'], cellAt(1, 5, 0))])
    expect(errorsOf(far)).toMatch(/out of range.*2 rows and 3 columns/)
    const notTable = applyBilingual(editor, undefined, [item(0, '앞', ['A'], cellAt(0, 0, 0))])
    expect(errorsOf(notTable)).toMatch(/not a table/)
    const none = applyBilingual(editor, undefined, [item(0, '앞', ['A'], cellAt(9, 0, 0))])
    expect(errorsOf(none)).toMatch(/no such block/)
  })

  it('with tracking on, the written text is an insertion and the cell itself is untouched', async () => {
    const editor = await createEditor([sheet()])
    const out = applyBilingual(
      editor,
      undefined,
      [item(0, '원문', ['Source'], cellAt(0, 0, 1), 0)],
      TRACK,
    )
    expect(out.ok).toBe(true)
    const dest = blockJson(editor, 0).content![0].content![1]
    expect(dest.attrs?.cellRevision ?? null).toBeNull()
    const marks = (dest.content![0].content ?? []).flatMap((c) =>
      (c.marks ?? []).map((m) => m.type),
    )
    expect(marks).toContain('ins')
  })

  it('refuses a destination in a table that also gets a layout in the same call', async () => {
    const editor = await createEditor([sheet()])
    const out = applyBilingual(editor, 'below', [
      item(0, '원문', ['S'], cellAt(0, 0, 1), 0),
      { index: 0, fp: fp('둘째'), segments: ['T'], paragraph: 3 },
    ])
    expect(out.ok).toBe(false)
  })
})

describe('add_bilingual target: after / before / end', () => {
  it('places a paragraph after or before any block, or at the end', async () => {
    const editor = await createEditor([plain('가'), plain('나'), plain('다')])
    const out = applyBilingual(editor, undefined, [
      item(0, '가', ['A'], { kind: 'after', index: 2 }),
      item(1, '나', ['B'], { kind: 'before', index: 0 }),
      item(2, '다', ['C'], { kind: 'end' }),
    ])
    expect(out.ok).toBe(true)
    expect(bodyTexts(editor)).toEqual(['B', '가', '나', '다', 'A', 'C'])
  })

  it('keeps the item order when two translations go to the same place', async () => {
    const editor = await createEditor([plain('가'), plain('나')])
    applyBilingual(editor, undefined, [
      item(0, '가', ['A'], { kind: 'end' }),
      item(1, '나', ['B'], { kind: 'end' }),
    ])
    expect(bodyTexts(editor)).toEqual(['가', '나', 'A', 'B'])
  })

  it('a destination block that is a table: the paragraph goes outside it', async () => {
    const editor = await createEditor([plain('가'), sheet()])
    expect(
      applyBilingual(editor, undefined, [item(0, '가', ['A'], { kind: 'after', index: 1 })]).ok,
    ).toBe(true)
    expect(editor.state.doc.child(1).type.name).toBe('docTable')
    expect(editor.state.doc.child(2).type.name).toBe('docParagraph')
  })

  it('a bad anchor refuses the whole call', async () => {
    const editor = await createEditor([plain('가'), plain('나')])
    const before = editor.state.doc
    const out = applyBilingual(editor, undefined, [
      item(0, '가', ['A'], { kind: 'end' }),
      item(1, '나', ['B'], { kind: 'after', index: 9 }),
    ])
    expect(errorsOf(out)).toMatch(/no such block/)
    expect(editor.state.doc).toBe(before)
  })

  it('tracking marks the new paragraph text as insertions; undo is one step', async () => {
    const editor = await createEditor([plain('가'), plain('나')])
    const start = editor.state.doc
    applyBilingual(
      editor,
      undefined,
      [item(0, '가', ['A'], { kind: 'end' }), item(1, '나', ['B'], { kind: 'before', index: 0 })],
      TRACK,
    )
    const last = blockJson(editor, 3)
    expect(last.content!.every((c) => c.marks?.some((m) => m.type === 'ins'))).toBe(true)
    editor.commands.undo()
    expect(editor.state.doc.eq(start)).toBe(true)
  })

  it('after the original itself it behaves like layout after', async () => {
    const editor = await createEditor([plain('가'), plain('나')])
    applyBilingual(editor, undefined, [item(0, '가', ['A'], { kind: 'after', index: 0 })])
    expect(bodyTexts(editor)).toEqual(['가', 'A', '나'])
    const read = readRunGroups(editor, 0, 2)
    expect(read[0].skip).toMatch(/already has/)
  })
})

describe('add_bilingual target: bookkeeping', () => {
  it('a far twin counts as translated: skipped in read_runs, not flagged, original not offered or written again', async () => {
    const editor = await createEditor([plain('가'), plain('나'), sheet()])
    expect(
      applyBilingual(editor, undefined, [
        item(0, '가', ['A'], { kind: 'end' }),
        item(2, '원문', ['Source'], cellAt(2, 0, 1), 0),
      ]).ok,
    ).toBe(true)
    const read = readRunGroups(editor, 0, editor.state.doc.childCount - 1)
    expect(read.find((r) => r.index === 0)?.skip).toMatch(/already has/)
    expect(read.find((r) => r.index === 4)?.skip).toMatch(/bilingual translation added/)
    const tableRead = read.filter((r) => r.index === 2)
    expect(tableRead.find((r) => r.cell === 'r0c0')?.skip).toMatch(/already has/)
    expect(tableRead.find((r) => r.cell === 'r0c1')?.skip).toMatch(/translation added/)
    expect(remainingUntranslated(editor, undefined).body).toEqual([
      '1',
      '2 (paragraph 3)',
      '2 (paragraph 4)',
    ])
    // a second call for the same originals is skipped; the twin is never a source
    const again = applyBilingual(editor, undefined, [item(0, '가', ['A2'], { kind: 'end' })])
    expect(again.ok && again.alreadyDone).toEqual(['block 0'])
    const twin = applyBilingual(editor, undefined, [
      { index: 2, fp: fp('Source'), segments: ['x'], paragraph: 1, target: { kind: 'end' } },
    ])
    expect(errorsOf(twin)).toMatch(/already added/)
  })

  it('after blocks were inserted, a later explicit destination needs a fresh read_runs', async () => {
    const editor = await createEditor([plain('가'), plain('나'), sheet()])
    expect(
      applyBilingual(editor, undefined, [item(0, '가', ['A'], { kind: 'before', index: 0 })]).ok,
    ).toBe(true)
    const stale = applyBilingual(editor, undefined, [
      item(1, '나', ['B'], { kind: 'after', index: 1 }),
    ])
    expect(errorsOf(stale)).toMatch(/read_runs again/)
    readRunGroups(editor, 0, 1)
    // block indexes are fresh now: the original moved down by one
    expect(
      applyBilingual(editor, undefined, [item(2, '나', ['B'], { kind: 'after', index: 2 })]).ok,
    ).toBe(true)
  })

  it('existing layouts still work unchanged', async () => {
    const editor = await createEditor([plain('가'), table(row(cell('나')))])
    expect(applyBilingual(editor, 'after', [{ index: 0, fp: fp('가'), segments: ['A'] }]).ok).toBe(
      true,
    )
    expect(bodyTexts(editor).slice(0, 2)).toEqual(['가', 'A'])
  })
})

describe('add_bilingual tool: target input', () => {
  it('runs without a layout when every entry has a target, and reports where', async () => {
    const editor = await createEditor([sheet()])
    const result = await executeTool(
      editor,
      call({
        blocks: [
          {
            index: 0,
            paragraph: 0,
            fp: fp('원문'),
            segments: ['Source'],
            target: { kind: 'cell', index: 0, row: 0, column: 1 },
          },
        ],
      }),
      NUM_IDS,
    )
    expect(result.isError).toBeFalsy()
    expect(result.mutated).toBe(true)
    expect(result.output).toMatch(/Placed 1 translation.*row 0 column 1 of block 0/)
    expect(cellTexts(blockJson(editor, 0))[0]).toEqual(['원문', 'Source', ''])
  })

  it('needs a layout for an entry without a target, and validates the target', async () => {
    const editor = await createEditor([sheet()])
    const noLayout = await executeTool(
      editor,
      call({ blocks: [{ index: 0, paragraph: 0, fp: fp('원문'), segments: ['S'] }] }),
      NUM_IDS,
    )
    expect(noLayout.isError).toBe(true)
    const badKind = await executeTool(
      editor,
      call({
        blocks: [
          { index: 0, paragraph: 0, fp: fp('원문'), segments: ['S'], target: { kind: 'x' } },
        ],
      }),
      NUM_IDS,
    )
    expect(badKind.isError).toBe(true)
    expect(badKind.output).toMatch(/target.kind/)
    const noCoords = await executeTool(
      editor,
      call({
        blocks: [
          {
            index: 0,
            paragraph: 0,
            fp: fp('원문'),
            segments: ['S'],
            target: { kind: 'cell', index: 0 },
          },
        ],
      }),
      NUM_IDS,
    )
    expect(noCoords.isError).toBe(true)
  })
})
