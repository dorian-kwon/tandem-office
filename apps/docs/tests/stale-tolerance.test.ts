import { applyAiPanelPrefs } from '@genoffice/ui'
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { BLANK_BULLET_NUM_ID, BLANK_ORDERED_NUM_ID } from '@genoffice/docx-engine'
import type { PmNode } from '../src/renderer/editor/convert'
import { runFingerprint } from '../src/renderer/ai/translate-runs'
import { executeTool, markDocSeen } from '../src/renderer/ai/tools'

/**
 * translate_blocks, add_bilingual and revise_blocks verify every paragraph by its fp, so a
 * paragraph the person edited after read_runs is skipped and reported while the rest is applied.
 * The global "document edited" gate stays for tools that address blocks by index alone.
 */

const NUM_IDS = { bullet: BLANK_BULLET_NUM_ID, ordered: BLANK_ORDERED_NUM_ID }
const STYLE = { font: 'Batang', sizeHalfPoints: 22, rawRPr: '<w:rPr><w:i/></w:rPr>' }
const text = (t: string): PmNode => ({
  type: 'text',
  text: t,
  marks: [{ type: 'docTextStyle', attrs: STYLE }],
})
const plain = (t: string): PmNode => ({ type: 'docParagraph', attrs: {}, content: [text(t)] })
const cell = (t: string): PmNode => ({
  type: 'docTableCell',
  attrs: { colwidth: [100] },
  content: [plain(t)],
})
const table = (...cells: string[]): PmNode => ({
  type: 'docTable',
  attrs: {},
  content: [{ type: 'docTableRow', content: cells.map(cell) }],
})

const live: Editor[] = []
afterEach(() => {
  applyAiPanelPrefs({})
  for (const e of live.splice(0)) e.destroy()
})
async function createEditor(blocks: PmNode[]): Promise<Editor> {
  const { editorExtensions } = await import('../src/renderer/editor/extensions')
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
  })
  live.push(editor)
  editor.view.dispatch(
    editor.state.tr
      .replaceWith(
        0,
        editor.state.doc.content.size,
        blocks.map((b) => editor.schema.nodeFromJSON(b)),
      )
      .setMeta('addToHistory', false),
  )
  markDocSeen(editor)
  return editor
}
/** the person types into top-level block `index` */
const userTypes = (editor: Editor, index: number, s = '!', depth = 1) => {
  let pos = depth
  for (let i = 0; i < index; i++) pos += editor.state.doc.child(i).nodeSize
  editor.view.dispatch(editor.state.tr.insertText(s, pos))
}
/** an unrelated doc change: a node attribute flips, text untouched */
const flipFlag = (editor: Editor, index: number) => {
  let pos = 0
  for (let i = 0; i < index; i++) pos += editor.state.doc.child(i).nodeSize
  const node = editor.state.doc.child(index)
  editor.view.dispatch(
    editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, aiChanged: true }),
  )
}
const fp = (t: string) => runFingerprint([t])
const entry = (index: number, t: string, segments: string[], paragraph?: number) => ({
  index,
  fp: fp(t),
  segments,
  ...(paragraph === undefined ? {} : { paragraph }),
})
const run = (editor: Editor, name: string, input: Record<string, unknown>) =>
  executeTool(editor, { id: 's', name, input }, NUM_IDS)
const bodyTexts = (editor: Editor): string[] =>
  editor.state.doc.content.content.map((b) => b.textContent)

describe('stale tolerance: translate_blocks', () => {
  it('applies the untouched paragraphs, skips the edited one and reports it', async () => {
    const editor = await createEditor([plain('가'), plain('나'), plain('다')])
    userTypes(editor, 1)
    const result = await run(editor, 'translate_blocks', {
      blocks: [entry(0, '가', ['A']), entry(1, '나', ['B']), entry(2, '다', ['C'])],
    })
    expect(result.isError).toBeFalsy()
    expect(bodyTexts(editor)).toEqual(['A', '!나', 'C'])
    expect(result.output).toMatch(/Applied 2; SKIPPED 1 item.*block 1.*read_runs/)
  })

  it('an unrelated doc object change no longer refuses the call', async () => {
    const editor = await createEditor([plain('가'), plain('나')])
    flipFlag(editor, 1)
    const result = await run(editor, 'translate_blocks', {
      blocks: [entry(0, '가', ['A']), entry(1, '나', ['B'])],
    })
    expect(result.isError).toBeFalsy()
    expect(bodyTexts(editor)).toEqual(['A', 'B'])
    expect(result.output).not.toMatch(/SKIPPED/)
  })

  it('every item stale returns the error with the read_runs advice', async () => {
    const editor = await createEditor([plain('가')])
    userTypes(editor, 0)
    const result = await run(editor, 'translate_blocks', { blocks: [entry(0, '가', ['A'])] })
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/fingerprint mismatch.*read_runs/s)
    expect(bodyTexts(editor)).toEqual(['!가'])
  })
})

describe('stale tolerance: revise_blocks', () => {
  it('skips the edited paragraph and applies the rest', async () => {
    const editor = await createEditor([plain('Teh cat'), plain('Teh dog')])
    userTypes(editor, 1)
    const result = await run(editor, 'revise_blocks', {
      blocks: [entry(0, 'Teh cat', ['The cat']), entry(1, 'Teh dog', ['The dog'])],
    })
    expect(result.isError).toBeFalsy()
    expect(result.output).toMatch(/SKIPPED 1 item.*block 1/)
    expect(result.mutated).toBe(true)
  })
})

describe('stale tolerance: add_bilingual', () => {
  it('with history off, manual undo removes the earlier typing and preserves later AI twins', async () => {
    const editor = await createEditor([plain('가'), plain('나'), plain('다')])
    userTypes(editor, 1)
    const result = await run(editor, 'add_bilingual', {
      layout: 'after',
      blocks: [entry(0, '가', ['A']), entry(1, '나', ['B']), entry(2, '다', ['C'])],
    })
    expect(result.isError).toBeFalsy()
    expect(editor.commands.undo()).toBe(true)
    expect(bodyTexts(editor)).toEqual(['가', 'A', '나', '다', 'C'])
  })

  it('adds the translation for the untouched paragraphs and skips the edited one', async () => {
    applyAiPanelPrefs({ aiEditUndoHistory: true })
    const editor = await createEditor([plain('가'), plain('나'), plain('다')])
    userTypes(editor, 1)
    const before = editor.state.doc
    const result = await run(editor, 'add_bilingual', {
      layout: 'after',
      blocks: [entry(0, '가', ['A']), entry(1, '나', ['B']), entry(2, '다', ['C'])],
    })
    expect(result.isError).toBeFalsy()
    expect(bodyTexts(editor)).toEqual(['가', 'A', '!나', '다', 'C'])
    expect(result.output).toMatch(/SKIPPED 1 item.*block 1/)
    editor.commands.undo()
    expect(editor.state.doc.eq(before)).toBe(true)
  })

  it('an unrelated doc change does not refuse; explicit targets work too', async () => {
    const editor = await createEditor([plain('가'), plain('나')])
    flipFlag(editor, 0)
    const result = await run(editor, 'add_bilingual', {
      blocks: [{ ...entry(0, '가', ['A']), target: { kind: 'end' } }],
    })
    expect(result.isError).toBeFalsy()
    expect(bodyTexts(editor).slice(-1)).toEqual(['A'])
  })

  it('a stale table is skipped whole while body paragraphs are applied', async () => {
    const editor = await createEditor([plain('가'), table('나', '다')])
    userTypes(editor, 1, 'x', 4)
    // block 1 is the table: the person typed into its first cell
    const tableBefore = editor.state.doc.child(1)
    const result = await run(editor, 'add_bilingual', {
      layout: 'right',
      blocks: [entry(0, '가', ['A']), entry(1, '나', ['B'], 0), entry(1, '다', ['C'], 1)],
    })
    expect(result.isError).toBeFalsy()
    expect(result.output).toMatch(/table block 1 skipped whole/)
    expect(editor.state.doc.child(2).eq(tableBefore)).toBe(true)
    expect(bodyTexts(editor)[1]).toBe('A')
  })

  it('every item stale returns the error', async () => {
    const editor = await createEditor([plain('가')])
    userTypes(editor, 0)
    const result = await run(editor, 'add_bilingual', {
      layout: 'after',
      blocks: [entry(0, '가', ['A'])],
    })
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/fingerprint mismatch/)
  })

  it('invalid input still refuses the whole call', async () => {
    const editor = await createEditor([plain('가'), plain('나')])
    const before = editor.state.doc
    const result = await run(editor, 'add_bilingual', {
      layout: 'after',
      blocks: [entry(0, '가', ['A']), { ...entry(1, '나', ['B']), target: { kind: 'bogus' } }],
    })
    expect(result.isError).toBe(true)
    expect(editor.state.doc).toBe(before)
  })
})

describe('the global gate still protects index-only tools', () => {
  it('replace_blocks is refused after the person edited the document', async () => {
    const editor = await createEditor([plain('가'), plain('나')])
    userTypes(editor, 0)
    const result = await run(editor, 'replace_blocks', {
      startBlockIndex: 1,
      endBlockIndex: 1,
      html: '<p>x</p>',
    })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('edited by the user')
  })
})
