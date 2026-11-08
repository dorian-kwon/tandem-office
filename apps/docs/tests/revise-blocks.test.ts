import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import type { CommentInfo } from '@genoffice/docx-engine'
import { BLANK_BULLET_NUM_ID, BLANK_ORDERED_NUM_ID } from '@genoffice/docx-engine'
import type { PmNode } from '../src/renderer/editor/convert'
import { addCommentToRange, nextCommentId } from '../src/renderer/editor/comments'
import { executeTool, AGENT_TOOLS, type AiCommentsAccess } from '../src/renderer/ai/tools'
import {
  applyRevisions,
  diffSpans,
  looksUntranslated,
  reviewAuthor,
} from '../src/renderer/ai/revise-runs'
import {
  readRunGroups,
  remainingUntranslated,
  runFingerprint,
  sourceScriptOf,
} from '../src/renderer/ai/translate-runs'

/**
 * revise_blocks: translation review. Minimal word-level diff, always tracked
 * under the review author, run formatting kept.
 */

const NUM_IDS = { bullet: BLANK_BULLET_NUM_ID, ordered: BLANK_ORDERED_NUM_ID }
const STYLE_A = { font: 'Arial', sizeHalfPoints: 22, rawRPr: '<w:rPr><w:b/></w:rPr>' }
const STYLE_B = { font: 'Arial', sizeHalfPoints: 22, rawRPr: '<w:rPr><w:i/></w:rPr>' }
const AUTHOR = 'AI Assistant (review)'

const text = (t: string, style: Record<string, unknown>): PmNode => ({
  type: 'text',
  text: t,
  marks: [{ type: 'docTextStyle', attrs: style }],
})
const noteRef: PmNode = {
  type: 'docNoteRef',
  attrs: { kind: 'footnote', id: '1', num: 1, rawRPr: '<w:rPr><w:rStyle w:val="a7"/></w:rPr>' },
}
const para = (content: PmNode[]): PmNode => ({
  type: 'docParagraph',
  attrs: { styleId: 'af5', docxIndex: 3 },
  content,
})
const mixed = (): PmNode =>
  para([text('The quick brown fox ', STYLE_A), noteRef, text('jumps over it.', STYLE_B)])
const empty: PmNode = { type: 'docParagraph', attrs: { styleId: 'BlankLine', docxIndex: 4 } }

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
const nodes = (n: PmNode) => n.content ?? []
const markTypes = (n: PmNode) => (n.marks ?? []).map((m) => m.type)

const revise = (
  editor: Editor,
  blocks: unknown[],
  track?: { author: string },
  extra: Record<string, unknown> = {},
) =>
  executeTool(
    editor,
    { id: 'r', name: 'revise_blocks', input: { blocks, ...extra } },
    NUM_IDS,
    track,
  )

const MIXED = ['The quick brown fox ', 'jumps over it.']
const FP = runFingerprint(MIXED)

describe('diffSpans', () => {
  it('marks only the changed word', () => {
    expect(diffSpans('The quick brown fox', 'The quick red fox')).toEqual([
      { start: 10, end: 15, text: 'red' },
    ])
  })
  it('an identical text has no change', () => {
    expect(diffSpans('same words', 'same words')).toEqual([])
  })
  it('an insertion and a deletion are pure spans', () => {
    expect(diffSpans('a b', 'a very b')).toEqual([{ start: 2, end: 2, text: 'very ' }])
    expect(diffSpans('a very b', 'a b')).toEqual([{ start: 2, end: 7, text: '' }])
  })
  it('two changes far apart stay two; neighbours a space apart become one', () => {
    expect(diffSpans('one two three four five', 'one 2 three four 5')).toHaveLength(2)
    expect(diffSpans('a big red car', 'a large crimson car')).toEqual([
      { start: 2, end: 9, text: 'large crimson' },
    ])
  })
  it('works character by character in CJK text', () => {
    expect(diffSpans('오늘은 날씨가 좋다', '오늘은 날씨가 나쁘다')).toEqual([
      { start: 8, end: 10, text: '나쁘다' },
    ])
    expect(diffSpans('我喜欢苹果', '我喜欢香蕉')).toEqual([{ start: 3, end: 5, text: '香蕉' }])
  })
})

describe('revise_blocks', () => {
  it('records only the changed word as a tracked change, even with the track switch off', async () => {
    const editor = await createEditor([mixed()])
    const result = await revise(editor, [
      { index: 0, fp: FP, segments: ['The quick red fox ', 'jumps over it.'] },
    ])
    expect(result.isError).toBeFalsy()
    expect(result.mutated).toBe(true)
    expect(result.output).toContain(AUTHOR)
    const content = nodes(block(editor, 0))
    const texts = content.filter((n) => n.type === 'text')
    expect(texts.map((n) => n.text)).toEqual([
      'The quick ',
      'brown',
      'red',
      ' fox ',
      'jumps over it.',
    ])
    expect(texts.map(markTypes)).toEqual([
      ['docTextStyle'],
      expect.arrayContaining(['docTextStyle', 'del']),
      expect.arrayContaining(['docTextStyle', 'ins']),
      ['docTextStyle'],
      ['docTextStyle'],
    ])
    // the run formatting of the edited word is the run's own
    for (const n of texts.slice(0, 4))
      expect(n.marks!.find((m) => m.type === 'docTextStyle')!.attrs).toMatchObject(STYLE_A)
    const del = texts[1].marks!.find((m) => m.type === 'del')!
    const ins = texts[2].marks!.find((m) => m.type === 'ins')!
    expect(del.attrs!.author).toBe(AUTHOR)
    expect(ins.attrs!.author).toBe(AUTHOR)
    // the footnote reference and the second run are untouched
    expect(content.some((n) => n.type === 'docNoteRef')).toBe(true)
  })

  it('the review author follows the AI author when the panel tracks changes', async () => {
    expect(reviewAuthor({ author: 'Bot' })).toBe('Bot (review)')
    const editor = await createEditor([mixed()])
    await revise(
      editor,
      [{ index: 0, fp: FP, segments: ['The quick red fox ', 'jumps over it.'] }],
      { author: 'Bot' },
    )
    const ins = nodes(block(editor, 0))
      .flatMap((n) => n.marks ?? [])
      .find((m) => m.type === 'ins')!
    expect(ins.attrs!.author).toBe('Bot (review)')
  })

  it('an unchanged segment makes no edit and no marks', async () => {
    const editor = await createEditor([mixed()])
    const before = editor.state.doc
    const result = await revise(editor, [{ index: 0, fp: FP, segments: [...MIXED] }])
    expect(result.isError).toBeFalsy()
    expect(result.mutated).toBe(false)
    expect(editor.state.doc.eq(before)).toBe(true)
    expect(result.output).toMatch(/No change/)
  })

  it('edge whitespace of a segment is never a change', async () => {
    const editor = await createEditor([mixed()])
    const before = editor.state.doc
    await revise(editor, [
      { index: 0, fp: FP, segments: ['The quick brown fox', ' jumps over it.  '] },
    ])
    expect(editor.state.doc.eq(before)).toBe(true)
  })

  it('refuses a stale fingerprint and changes nothing', async () => {
    const editor = await createEditor([mixed()])
    const before = editor.state.doc
    const result = await revise(editor, [
      { index: 0, fp: 'stale', segments: ['The quick red fox ', 'jumps over it.'] },
    ])
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/fingerprint mismatch/)
    expect(editor.state.doc.eq(before)).toBe(true)
  })

  it('one bad item refuses the whole call', async () => {
    const editor = await createEditor([mixed(), mixed()])
    const before = editor.state.doc
    const result = await revise(editor, [
      { index: 0, fp: FP, segments: ['The quick red fox ', 'jumps over it.'] },
      { index: 1, fp: 'stale', segments: [...MIXED] },
    ])
    expect(result.isError).toBe(true)
    expect(editor.state.doc.eq(before)).toBe(true)
  })

  it('wants exactly one string per segment', async () => {
    const editor = await createEditor([mixed()])
    const result = await revise(editor, [{ index: 0, fp: FP, segments: ['The quick red fox '] }])
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/exactly one string per segment/)
  })

  it('refuses to delete a whole paragraph through empty segments', async () => {
    const editor = await createEditor([mixed()])
    const result = await revise(editor, [{ index: 0, fp: FP, segments: ['', ''] }])
    expect(result.isError).toBe(true)
  })

  it('leaves an empty paragraph untouched', async () => {
    const editor = await createEditor([empty, mixed()])
    const before = block(editor, 0)
    const outcome = applyRevisions(editor, [{ index: 0, fp: 'anything', segments: ['x'] }])
    expect(outcome.ok).toBe(true)
    expect(outcome.ok && outcome.reports[0].empty).toBe(true)
    expect(block(editor, 0)).toEqual(before)
  })

  it('refuses a note entry (notes carry no tracked changes)', async () => {
    const editor = await createEditor([mixed()])
    const result = await revise(editor, [{ note: 'footnote', id: '1', fp: 'x', segments: ['y'] }])
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/cannot carry tracked changes/)
  })

  it('is one undo step', async () => {
    const editor = await createEditor([mixed()])
    const before = editor.state.doc
    await revise(editor, [
      { index: 0, fp: FP, segments: ['The slow red fox ', 'jumps over that.'] },
    ])
    expect(editor.state.doc.eq(before)).toBe(false)
    editor.commands.undo()
    expect(editor.state.doc.eq(before)).toBe(true)
  })

  it('a second pass replaces its own insertion instead of deleting it again', async () => {
    const editor = await createEditor([mixed()])
    await revise(editor, [{ index: 0, fp: FP, segments: ['The quick red fox ', 'jumps over it.'] }])
    const listed = readRunGroups(editor, 0, 0)[0]
    const segs = [...listed.segments!]
    const at = segs.indexOf('red')
    expect(at).toBeGreaterThan(-1)
    segs[at] = 'crimson'
    const result = await revise(editor, [{ index: 0, fp: listed.fp, segments: segs }])
    expect(result.isError).toBeFalsy()
    const texts = nodes(block(editor, 0)).filter((n) => n.type === 'text')
    expect(texts.map((n) => n.text)).toContain('crimson')
    expect(texts.map((n) => n.text)).not.toContain('red')
    // only the original word is a deletion
    expect(texts.filter((n) => markTypes(n).includes('del')).map((n) => n.text)).toEqual(['brown'])
  })

  it('a paragraph still in the source language is reported, not revised', async () => {
    const korean = para([text('이것은 아직 번역되지 않은 문장입니다.', STYLE_A)])
    const editor = await createEditor([korean, mixed()])
    const kfp = runFingerprint(['이것은 아직 번역되지 않은 문장입니다.'])
    const before = block(editor, 0)
    const result = await revise(
      editor,
      [
        { index: 0, fp: kfp, segments: ['This is a sentence.'] },
        { index: 1, fp: FP, segments: ['The quick red fox ', 'jumps over it.'] },
      ],
      undefined,
      { sourceLanguage: 'Korean' },
    )
    expect(block(editor, 0)).toEqual(before)
    expect(result.output).toMatch(/NOT revised[^\n]*block 0/)
    expect(result.mutated).toBe(true)
    expect(looksUntranslated(['한글 한국어 text'], sourceScriptOf('ko')!)).toBe(true)
    expect(looksUntranslated(['A name 김'], sourceScriptOf('ko')!)).toBe(false)
  })

  it('a reviewed document is not reported as untranslated', async () => {
    const editor = await createEditor([mixed()])
    expect(remainingUntranslated(editor, undefined).body).toEqual(['0'])
    await revise(editor, [{ index: 0, fp: FP, segments: ['The quick red fox ', 'jumps over it.'] }])
    expect(remainingUntranslated(editor, undefined).body).toEqual([])
  })

  it('is offered as a tool, described for review', () => {
    const tool = AGENT_TOOLS.find((t) => t.name === 'revise_blocks')!
    expect(tool.description).toMatch(/TRACKED CHANGE/)
    expect(tool.description).toMatch(/word by word/)
    expect(tool.description).toMatch(/never the same comment twice/)
    expect(tool.description).toMatch(/original of a bilingual pair is never edited/)
  })
})

describe('revise_blocks in a bilingual document', () => {
  it('review reads list both sides; the translation is revised, the original refused', async () => {
    const editor = await createEditor([para([text('가나다', STYLE_A)])])
    const added = await executeTool(
      editor,
      {
        id: 'b',
        name: 'add_bilingual',
        input: {
          layout: 'after',
          blocks: [{ index: 0, fp: runFingerprint(['가나다']), segments: ['ABC wrong'] }],
        },
      },
      NUM_IDS,
    )
    expect(added.isError).toBeFalsy()
    const listed = readRunGroups(editor, 0, 1, { review: true })
    expect(listed[0]).toMatchObject({ index: 0, role: 'original', segments: ['가나다'] })
    expect(listed[0].fp).toBeUndefined()
    expect(listed[1]).toMatchObject({ index: 1, role: 'translation', segments: ['ABC wrong'] })
    const original = await revise(editor, [
      { index: 0, fp: runFingerprint(['가나다']), segments: ['가나라'] },
    ])
    expect(original.isError).toBe(true)
    expect(original.output).toMatch(/never edit the original/)
    const fixed = await revise(editor, [{ index: 1, fp: listed[1].fp, segments: ['ABC right'] }])
    expect(fixed.isError).toBeFalsy()
    expect(nodes(block(editor, 0)).map((n) => n.text)).toEqual(['가나다'])
  })
})

describe('add_comment duplicate guard', () => {
  it('refuses the same comment twice on one block, allows it on another block', async () => {
    const editor = await createEditor([mixed(), mixed()])
    const comments: CommentInfo[] = []
    const access: AiCommentsAccess = {
      list: () => comments,
      reply: () => false,
      resolve: () => false,
      add: (range, body, meta) => {
        const id = nextCommentId(comments)
        if (!addCommentToRange(editor, range.from, range.to, id)) return null
        comments.push({
          id,
          author: meta.author ?? AUTHOR,
          date: '2026-01-01T00:00:00Z',
          text: body,
        })
        return id
      },
    }
    const add = (blockIndex: number, comment: string) =>
      executeTool(
        editor,
        { id: 'c', name: 'add_comment', input: { blockIndex, comment } },
        NUM_IDS,
        undefined,
        undefined,
        undefined,
        access,
      )
    expect((await add(0, 'Source says 2019, not 2018.')).isError).toBeFalsy()
    const dup = await add(0, '  source says 2019, not 2018. ')
    expect(dup.isError).toBe(true)
    expect(dup.output).toMatch(/already has this exact comment/)
    expect(comments).toHaveLength(1)
    expect((await add(1, 'Source says 2019, not 2018.')).isError).toBeFalsy()
    expect(comments).toHaveLength(2)
  })
})
