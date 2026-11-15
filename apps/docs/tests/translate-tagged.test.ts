import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import JSZip from 'jszip'
import {
  BLANK_BULLET_NUM_ID,
  BLANK_ORDERED_NUM_ID,
  parseDocx,
  saveDocx,
} from '@genoffice/docx-engine'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { blocksToPmDoc, pmDocToSavePlan, type PmNode } from '../src/renderer/editor/convert'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { applyRunTranslations, readRunGroups } from '../src/renderer/ai/translate-runs'
import { executeTool } from '../src/renderer/ai/tools'

/**
 * A paragraph of mixed formatting is translated as one sentence, not run by run: read_runs shows
 * it with numbered tags, one number per distinct formatting (`<1>plain</1><2>bold</2>`), and
 * the translation comes back with the same tags around the words that correspond. The app puts
 * the original formatting of tag N on whatever the translation put inside tag N, wherever it
 * stands in the sentence. The model never writes formatting; it only moves tags.
 */

;(globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s }

const run = (text: string, rPr = '') => `<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r>`
const BOLD = '<w:rPr><w:b/></w:rPr>'
const ITALIC = '<w:rPr><w:i/></w:rPr>'
const SMALL = '<w:rPr><w:sz w:val="18"/></w:rPr>'
const para = (inner: string) => `<w:p>${inner}</w:p>`

const live: Editor[] = []
afterEach(() => live.splice(0).forEach((e) => e.destroy()))
async function open(bodyXml: string) {
  const bytes = await buildDocx({ bodyXml })
  const parsed = await parseDocx(bytes)
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: blocksToPmDoc(parsed.blocks) as never,
  })
  live.push(editor)
  return { parsed, editor }
}
const entry = (editor: Editor, index = 0) =>
  readRunGroups(editor, 0, editor.state.doc.childCount - 1).find((e) => e.index === index)!
/** the text of a paragraph with the names of the formats it carries, piece by piece */
const pieces = (editor: Editor, index = 0) => {
  const out: Array<[string, string]> = []
  editor.state.doc.child(index).forEach((child) => {
    out.push([
      child.text ?? '',
      child.marks
        .map((m) => {
          if (m.type.name === 'docTextStyle')
            return m.attrs.sizeHalfPoints ? `sz${m.attrs.sizeHalfPoints}` : ''
          return m.type.name
        })
        .filter(Boolean)
        .sort()
        .join('+'),
    ])
  })
  return out
}

describe('how read_runs shows a paragraph of mixed formatting', () => {
  it('numbers each distinct formatting and says what it is', async () => {
    const { editor } = await open(
      para(run('이것은 ') + run('중요한', BOLD) + run(' 문장이고 ') + run('작은 글자', SMALL)),
    )
    const e = entry(editor)
    expect(e.tagged).toBe('<1>이것은 </1><2>중요한</2><1> 문장이고 </1><3>작은 글자</3>')
    expect(e.tags?.['2']).toMatch(/bold/)
    expect(e.tags?.['3']).toMatch(/9\s?pt/)
    // the way of translating run by run stays available
    expect(e.segments).toEqual(['이것은 ', '중요한', ' 문장이고 ', '작은 글자'])
  })

  it('gives nothing extra for a paragraph of one formatting', async () => {
    const { editor } = await open(para(run('한 가지 서식만 있는 문장입니다.')))
    expect(entry(editor).tagged).toBeUndefined()
  })

  it('gives nothing extra when something other than text sits among the runs', async () => {
    const { editor } = await open(
      para(run('앞 ') + '<w:r><w:tab/></w:r>' + run('굵게', BOLD) + run(' 뒤')),
    )
    expect(entry(editor).tagged).toBeUndefined()
  })
})

describe('translating a paragraph with its tags', () => {
  it('puts each formatting on the words inside its tag', async () => {
    const { editor } = await open(para(run('이것은 ') + run('중요한', BOLD) + run(' 문장입니다.')))
    const e = entry(editor)
    const out = applyRunTranslations(editor, [
      { index: 0, fp: e.fp, tagged: '<1>This is an </1><2>important</2><1> sentence.</1>' },
    ])
    expect(out.ok).toBe(true)
    expect(pieces(editor)).toEqual([
      ['This is an ', ''],
      ['important', 'bold'],
      [' sentence.', ''],
    ])
  })

  it('follows the tags when the translation moves words across formats', async () => {
    const { editor } = await open(para(run('이것은 ') + run('중요한', BOLD) + run(' 문장입니다.')))
    const e = entry(editor)
    applyRunTranslations(editor, [
      { index: 0, fp: e.fp, tagged: '<2>Importantly</2><1>, this is a sentence.</1>' },
    ])
    expect(pieces(editor)).toEqual([
      ['Importantly', 'bold'],
      [', this is a sentence.', ''],
    ])
  })

  it('may use a tag twice, or leave one out', async () => {
    const { editor } = await open(para(run('가 ') + run('나', ITALIC) + run(' 다')))
    const e = entry(editor)
    applyRunTranslations(editor, [
      { index: 0, fp: e.fp, tagged: '<2>B</2><1> and </1><2>B again</2>' },
    ])
    expect(pieces(editor)).toEqual([
      ['B', 'italic'],
      [' and ', ''],
      ['B again', 'italic'],
    ])
  })

  it('refuses an unknown tag and changes nothing', async () => {
    const { editor } = await open(para(run('가 ') + run('나', BOLD)))
    const e = entry(editor)
    const before = pieces(editor)
    const out = applyRunTranslations(editor, [{ index: 0, fp: e.fp, tagged: '<1>A </1><3>B</3>' }])
    expect(out.ok).toBe(false)
    expect(JSON.stringify(out)).toMatch(/tag 3/)
    expect(pieces(editor)).toEqual(before)
  })

  it('refuses tags that do not close, and changes nothing', async () => {
    const { editor } = await open(para(run('가 ') + run('나', BOLD)))
    const e = entry(editor)
    const before = pieces(editor)
    const out = applyRunTranslations(editor, [{ index: 0, fp: e.fp, tagged: '<1>A <2>B</1></2>' }])
    expect(out.ok).toBe(false)
    expect(pieces(editor)).toEqual(before)
  })

  it('attaches words left outside every tag to the formatting beside them', async () => {
    const { editor } = await open(para(run('가 ') + run('나', BOLD)))
    const e = entry(editor)
    applyRunTranslations(editor, [{ index: 0, fp: e.fp, tagged: 'Lead <1>A </1><2>B</2>' }])
    expect(
      pieces(editor)
        .map(([t]) => t)
        .join(''),
    ).toBe('Lead A B')
    expect(pieces(editor)[pieces(editor).length - 1]).toEqual(['B', 'bold'])
  })

  it('skips a paragraph that changed since it was read, like any other item', async () => {
    const { editor } = await open(para(run('가 ') + run('나', BOLD)))
    const out = applyRunTranslations(editor, [
      { index: 0, fp: 'stale', tagged: '<1>A </1><2>B</2>' },
    ])
    expect(out.ok).toBe(false)
  })

  it('keeps the change one undo step', async () => {
    const { editor } = await open(para(run('가 ') + run('나', BOLD)))
    const e = entry(editor)
    const before = pieces(editor)
    applyRunTranslations(editor, [{ index: 0, fp: e.fp, tagged: '<1>A </1><2>B</2>' }])
    editor.commands.undo()
    expect(pieces(editor)).toEqual(before)
  })

  it('works inside a table cell', async () => {
    const cell = para(run('칸 ') + run('굵게', BOLD))
    const { editor } = await open(
      `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr>${cell}</w:tc></w:tr></w:tbl><w:p/>`,
    )
    const e = readRunGroups(editor, 0, 0).find((x) => x.tagged)!
    expect(e.tagged).toBe('<1>칸 </1><2>굵게</2>')
    const out = applyRunTranslations(editor, [
      { index: 0, paragraph: e.paragraph, fp: e.fp, tagged: '<2>Bold</2><1> cell</1>' },
    ])
    expect(out.ok).toBe(true)
    const marks: string[] = []
    editor.state.doc.descendants((n) => {
      if (n.isText)
        marks.push(
          `${n.text}:${n.marks
            .map((m) => m.type.name)
            .filter((name) => name !== 'docTextStyle')
            .join('+')}`,
        )
    })
    expect(marks).toEqual(['Bold:bold', ' cell:'])
  })

  it('saves the formatting where the tags put it', async () => {
    const { parsed, editor } = await open(
      para(run('이것은 ') + run('중요한', BOLD) + run(' 문장입니다.')),
    )
    const e = entry(editor)
    applyRunTranslations(editor, [
      { index: 0, fp: e.fp, tagged: '<1>This is </1><2>important</2><1>.</1>' },
    ])
    const plan = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
    const out = await saveDocx(parsed, plan.saveBlocks)
    const xml = await (await JSZip.loadAsync(out)).file('word/document.xml')!.async('string')
    const runs = [...xml.matchAll(/<w:r>(.*?)<\/w:r>/gs)].map((m) => m[1]!)
    const bolded = runs
      .filter((r) => r.includes('<w:b/>'))
      .map((r) => /<w:t[^>]*>([^<]*)/.exec(r)![1])
    expect(bolded).toEqual(['important'])
    expect(xml).toContain('This is ')
  })
})

describe('with revision tracking on', () => {
  it('records the old text as deleted and the translation as inserted, each piece with its formatting', async () => {
    const { editor } = await open(para(run('가 ') + run('나', BOLD)))
    const e = entry(editor)
    const out = applyRunTranslations(
      editor,
      [{ index: 0, fp: e.fp, tagged: '<1>A </1><2>B</2>' }],
      { author: 'AI' },
    )
    expect(out.ok).toBe(true)
    const kinds: string[] = []
    editor.state.doc.child(0).forEach((n) =>
      kinds.push(
        `${n.text}:${n.marks
          .map((m) => m.type.name)
          .sort()
          .join('+')}`,
      ),
    )
    expect(kinds.some((k) => k.startsWith('B:') && k.includes('bold') && k.includes('ins'))).toBe(
      true,
    )
    expect(kinds.some((k) => k.startsWith('A :') && k.includes('ins') && !k.includes('bold'))).toBe(
      true,
    )
    expect(kinds.some((k) => k.includes('del'))).toBe(true)
  })
})

describe('through the tools the model calls', () => {
  const NUM_IDS = { bullet: BLANK_BULLET_NUM_ID, ordered: BLANK_ORDERED_NUM_ID }
  const read = (editor: Editor) =>
    executeTool(
      editor,
      { id: 'r', name: 'read_runs', input: { startBlockIndex: 0, endBlockIndex: 0 } },
      NUM_IDS,
    )
  const translate = (editor: Editor, block: Record<string, unknown>) =>
    executeTool(editor, { id: 't', name: 'translate_blocks', input: { blocks: [block] } }, NUM_IDS)

  it('read_runs lists the tagged text and what the tags are', async () => {
    const { editor } = await open(para(run('이것은 ') + run('중요한', BOLD) + run(' 문장입니다.')))
    const out = await read(editor)
    expect(out.output).toContain('"tagged":"<1>이것은 </1><2>중요한</2><1> 문장입니다.</1>"')
    expect(out.output).toMatch(/"tags":\{"1":"regular","2":"bold"\}/)
  })

  it('translate_blocks takes "tagged" in place of segments', async () => {
    const { editor } = await open(para(run('이것은 ') + run('중요한', BOLD) + run(' 문장입니다.')))
    const e = entry(editor)
    const out = await translate(editor, {
      index: 0,
      fp: e.fp,
      tagged: '<1>This is an </1><2>important</2><1> sentence.</1>',
    })
    expect(out.isError).toBeFalsy()
    expect(out.mutated).toBe(true)
    expect(pieces(editor)[1]).toEqual(['important', 'bold'])
  })

  it('refuses "tagged" together with segments, and changes nothing', async () => {
    const { editor } = await open(para(run('가 ') + run('나', BOLD)))
    const e = entry(editor)
    const before = editor.state.doc
    const out = await translate(editor, {
      index: 0,
      fp: e.fp,
      tagged: '<1>A </1><2>B</2>',
      segments: ['A ', 'B'],
    })
    expect(out.isError).toBe(true)
    expect(editor.state.doc).toBe(before)
  })

  it('still takes segments for a paragraph that has tags, run by run as before', async () => {
    const { editor } = await open(para(run('가 ') + run('나', BOLD)))
    const e = entry(editor)
    const out = await translate(editor, { index: 0, fp: e.fp, segments: ['A ', 'B'] })
    expect(out.isError).toBeFalsy()
    expect(pieces(editor)).toEqual([
      ['A ', ''],
      ['B', 'bold'],
    ])
  })

  it('refuses a tagged paragraph whose tags do not fit, telling the model what is wrong', async () => {
    const { editor } = await open(para(run('가 ') + run('나', BOLD)))
    const e = entry(editor)
    const out = await translate(editor, { index: 0, fp: e.fp, tagged: '<1>A </1><7>B</7>' })
    expect(out.isError).toBe(true)
    expect(out.output).toMatch(/tag 7 does not exist/)
  })
})
