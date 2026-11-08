import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { BLANK_BULLET_NUM_ID, BLANK_ORDERED_NUM_ID } from '@genoffice/docx-engine'
import type { PmNode } from '../src/renderer/editor/convert'
import { runFingerprint } from '../src/renderer/ai/translate-runs'
import {
  italicTagError,
  joinParsed,
  parseItalicSegment,
  placeSpans,
  stripItalicTags,
} from '../src/renderer/ai/italic-spans'
import { executeTool } from '../src/renderer/ai/tools'

/**
 * <i>…</i> inside a segment of translate_blocks, add_bilingual and revise_blocks: an added
 * italic mark on exactly that span, on top of the run's own marks; the plain text is what
 * every check sees and no tag ever reaches the document.
 */

const NUM_IDS = { bullet: BLANK_BULLET_NUM_ID, ordered: BLANK_ORDERED_NUM_ID }
const STYLE = { font: 'Batang', sizeHalfPoints: 22, rawRPr: '<w:rPr><w:b/></w:rPr>' }
const TRACK = { author: 'AI Assistant' }

const run = (t: string, extra: PmNode['marks'] = []): PmNode => ({
  type: 'text',
  text: t,
  marks: [{ type: 'docTextStyle', attrs: STYLE }, ...(extra ?? [])],
})
const para = (...content: PmNode[]): PmNode => ({
  type: 'docParagraph',
  attrs: { styleId: 'af5', docxIndex: 3 },
  content,
})
const SOURCE = '동학을 읽었다.'
const FP = runFingerprint([SOURCE])
const sourceParagraph = (): PmNode => para(run(SOURCE, [{ type: 'bold' }]))

const live: Editor[] = []
afterEach(() => {
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
  return editor
}
const block = (editor: Editor, i: number): PmNode => ((editor.getJSON() as PmNode).content ?? [])[i]
const runs = (n: PmNode) => (n.content ?? []).filter((c) => c.type === 'text')
const names = (n: PmNode) => (n.marks ?? []).map((m) => m.type).sort()
const docText = (editor: Editor) => editor.state.doc.textContent
const translate = (editor: Editor, segments: string[], track?: { author: string }) =>
  executeTool(
    editor,
    { id: 't', name: 'translate_blocks', input: { blocks: [{ index: 0, fp: FP, segments }] } },
    NUM_IDS,
    track,
  )

describe('italic span parsing', () => {
  it('strips the tags and keeps the span as ranks of visible characters', () => {
    const p = parseItalicSegment('I read <i>Donghak</i> twice.')
    expect(p.plain).toBe('I read Donghak twice.')
    expect(p.spans).toEqual([[5, 12]])
    expect(stripItalicTags('<I>a</I>')).toBe('a')
  })
  it('a span survives whitespace settling', () => {
    const p = parseItalicSegment('I read <i>Donghak</i>.')
    expect(placeSpans(' I  read Donghak.', p)).toEqual([[9, 16]])
    // a different visible text drops the spans instead of misplacing them
    expect(placeSpans('Something else', p)).toEqual([])
  })
  it('joins spans of segments appended to one group', () => {
    const a = parseItalicSegment('<i>A</i> b')
    const b = parseItalicSegment('c <i>d</i>')
    expect(joinParsed([a, b], 'A b c d').spans).toEqual([
      [0, 1],
      [3, 4],
    ])
  })
  it('flags nested, unbalanced and unclosed tags only', () => {
    expect(italicTagError('<i>a<i>b</i></i>')).toMatch(/nested/)
    expect(italicTagError('a</i>')).toMatch(/without/)
    expect(italicTagError('<i>a')).toMatch(/never closed/)
    expect(italicTagError('<i>a</i> and <i>b</i>')).toBeNull()
    expect(italicTagError('plain')).toBeNull()
  })
})

describe('translate_blocks with <i>', () => {
  it('writes the span as an italic text node on top of the run marks (bold kept) and no tag reaches the document', async () => {
    const editor = await createEditor([sourceParagraph()])
    const exec = await translate(editor, ['I read <i>Donghak</i> today.'])
    expect(exec.isError).toBeFalsy()
    expect(docText(editor)).toBe('I read Donghak today.')
    expect(docText(editor)).not.toMatch(/<\/?i>/)
    expect(exec.output).not.toMatch(/<\/?i>/)
    const r = runs(block(editor, 0))
    expect(r.map((n) => n.text)).toEqual(['I read ', 'Donghak', ' today.'])
    expect(r.map(names)).toEqual([
      ['bold', 'docTextStyle'],
      ['bold', 'docTextStyle', 'italic'],
      ['bold', 'docTextStyle'],
    ])
  })

  it('leaves an italic run italic and never removes italics', async () => {
    const editor = await createEditor([para(run(SOURCE, [{ type: 'italic' }]))])
    await translate(editor, ['I read <i>Donghak</i> today.'])
    const r = runs(block(editor, 0))
    expect(r.every((n) => names(n).includes('italic'))).toBe(true)
    const again = await createEditor([para(run(SOURCE, [{ type: 'italic' }]))])
    await translate(again, ['I read Donghak today.'])
    expect(runs(block(again, 0)).every((n) => names(n).includes('italic'))).toBe(true)
  })

  it('keeps the span right after the edge whitespace and tidy spacing settle', async () => {
    const editor = await createEditor([sourceParagraph()])
    await translate(editor, [' <i>Donghak</i>  was read , twice. '])
    expect(docText(editor)).toBe(' Donghak was read, twice. ')
    const italic = runs(block(editor, 0)).filter((n) => names(n).includes('italic'))
    expect(italic.map((n) => n.text)).toEqual(['Donghak'])
  })

  it('refuses unbalanced, nested and other tags with nothing changed', async () => {
    const editor = await createEditor([sourceParagraph()])
    const before = editor.state.doc
    for (const bad of [
      '<i>a',
      'a</i>',
      '<i>a<i>b</i></i>',
      '<i class="x">a</i>',
      '<b>a</b>',
      '<i>a</i><em>b</em>',
    ]) {
      const exec = await translate(editor, [bad])
      expect(exec.isError).toBe(true)
      expect(editor.state.doc).toBe(before)
    }
  })

  it('tracked changes: the inserted text carries ins + italic, the old text is struck', async () => {
    const editor = await createEditor([sourceParagraph()])
    await translate(editor, ['I read <i>Donghak</i> today.'], TRACK)
    const r = runs(block(editor, 0))
    const inserted = r.filter((n) => names(n).includes('ins'))
    expect(inserted.map((n) => n.text)).toEqual(['I read ', 'Donghak', ' today.'])
    expect(inserted.filter((n) => names(n).includes('italic')).map((n) => n.text)).toEqual([
      'Donghak',
    ])
    expect(inserted.every((n) => names(n).includes('bold'))).toBe(true)
    expect(r.filter((n) => names(n).includes('del')).map((n) => n.text)).toEqual([SOURCE])
    expect(docText(editor)).not.toMatch(/<\/?i>/)
  })

  it('the fingerprint and segment count logic stay on plain text', async () => {
    const editor = await createEditor([sourceParagraph(), para(run('x'))])
    // two segments for one run: the extra one is appended, its span follows
    const exec = await translate(editor, ['I read ', '<i>Donghak</i>'])
    expect(exec.isError).toBeFalsy()
    expect(
      block(editor, 0)
        .content?.map((n) => n.text)
        .join(''),
    ).toBe('I read Donghak')
    expect(
      runs(block(editor, 0))
        .filter((n) => names(n).includes('italic'))
        .map((n) => n.text),
    ).toEqual(['Donghak'])
    // the fingerprint of the result is computed on the document text
    const read = await executeTool(
      editor,
      { id: 'r', name: 'read_runs', input: { startBlockIndex: 0, endBlockIndex: 1 } },
      NUM_IDS,
    )
    // the italic span is now a run of its own: two segments, listed as plain text
    expect(read.output).toContain(`"fp":"${runFingerprint(['I read ', 'Donghak'])}"`)
    expect(read.output).toContain('"segments":["I read ","Donghak"]')
    expect(read.output).not.toMatch(/<\/?i>/)
  })

  it('a segment whose plain text equals the current text gets no italic (never a style-only edit)', async () => {
    const editor = await createEditor([para(run('Donghak', [{ type: 'bold' }]))])
    const before = editor.state.doc
    await executeTool(
      editor,
      {
        id: 't',
        name: 'translate_blocks',
        input: {
          blocks: [{ index: 0, fp: runFingerprint(['Donghak']), segments: ['<i>Donghak</i>'] }],
        },
      },
      NUM_IDS,
    )
    expect(editor.state.doc.eq(before)).toBe(true)
  })
})

describe('add_bilingual with <i>', () => {
  const add = (editor: Editor, segments: string[], track?: { author: string }) =>
    executeTool(
      editor,
      {
        id: 'b',
        name: 'add_bilingual',
        input: { layout: 'after', blocks: [{ index: 0, fp: FP, segments }] },
      },
      NUM_IDS,
      track,
    )

  it('the added twin carries the italic span on top of the run marks; the original is untouched', async () => {
    const editor = await createEditor([sourceParagraph()])
    const exec = await add(editor, [' I read <i>Donghak</i>. '])
    expect(exec.isError).toBeFalsy()
    expect(block(editor, 0).content?.[0].text).toBe(SOURCE)
    const twin = runs(block(editor, 1))
    expect(twin.map((n) => n.text)).toEqual(['I read ', 'Donghak', '.'])
    expect(twin.map(names)).toEqual([
      ['bold', 'docTextStyle'],
      ['bold', 'docTextStyle', 'italic'],
      ['bold', 'docTextStyle'],
    ])
    expect(docText(editor)).not.toMatch(/<\/?i>/)
    expect(exec.output).not.toMatch(/<\/?i>/)
  })

  it('works in tracked mode and refuses bad tags', async () => {
    const editor = await createEditor([sourceParagraph()])
    expect((await add(editor, ['<b>x</b>'])).isError).toBe(true)
    expect((await add(editor, ['<i>x'])).isError).toBe(true)
    await add(editor, ['I read <i>Donghak</i>.'], TRACK)
    const twin = runs(block(editor, 1))
    expect(twin.every((n) => names(n).includes('ins'))).toBe(true)
    expect(twin.filter((n) => names(n).includes('italic')).map((n) => n.text)).toEqual(['Donghak'])
  })
})

describe('revise_blocks with <i>', () => {
  const EN = 'I read the book today.'
  const enFp = runFingerprint([EN])
  const revise = (editor: Editor, segments: string[]) =>
    executeTool(
      editor,
      { id: 'r', name: 'revise_blocks', input: { blocks: [{ index: 0, fp: enFp, segments }] } },
      NUM_IDS,
    )

  it('an inserted word takes the italic span; the tracked insertion keeps ins and the run marks', async () => {
    const editor = await createEditor([para(run(EN, [{ type: 'bold' }]))])
    const exec = await revise(editor, ['I read <i>Donghak</i> today.'])
    expect(exec.isError).toBeFalsy()
    const r = runs(block(editor, 0))
    const italic = r.filter((n) => names(n).includes('italic'))
    expect(italic.map((n) => n.text)).toEqual(['Donghak'])
    expect(names(italic[0])).toEqual(expect.arrayContaining(['ins', 'bold', 'docTextStyle']))
    // the struck text is the replaced words, never styled
    expect(r.filter((n) => names(n).includes('del')).map((n) => n.text)).toEqual(['the book'])
    expect(r.filter((n) => names(n).includes('del')).some((n) => names(n).includes('italic'))).toBe(
      false,
    )
    expect(docText(editor)).not.toMatch(/<\/?i>/)
    expect(exec.output).not.toMatch(/<\/?i>/)
  })

  it('an italic-only change of unchanged text is skipped: no tracked change at all', async () => {
    const editor = await createEditor([para(run(EN, [{ type: 'bold' }]))])
    const before = editor.state.doc
    const exec = await revise(editor, ['I read the <i>book</i> today.'])
    expect(exec.isError).toBeFalsy()
    expect(editor.state.doc.eq(before)).toBe(true)
  })

  it('refuses markup other than a flat <i>', async () => {
    const editor = await createEditor([para(run(EN))])
    expect((await revise(editor, ['I read <u>the</u> book today.'])).isError).toBe(true)
    expect((await revise(editor, ['I read <i>the <i>book</i></i> today.'])).isError).toBe(true)
  })
})
