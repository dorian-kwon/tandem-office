import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { BLANK_BULLET_NUM_ID, BLANK_ORDERED_NUM_ID } from '@genoffice/docx-engine'
import type { NoteInfo } from '@genoffice/docx-engine'
import type { PmNode } from '../src/renderer/editor/convert'
import { executeTool } from '../src/renderer/ai/tools'
import type { AiNotesAccess, NoteKind } from '../src/renderer/ai/note-ops'
import { settleTexts, sourceScriptOf } from '../src/renderer/ai/translate-runs'

/** footnote translation, the stray-space fix and the completion check */

const NUM_IDS = { bullet: BLANK_BULLET_NUM_ID, ordered: BLANK_ORDERED_NUM_ID }
const STYLE = { font: 'Batang', sizeHalfPoints: 22, rawRPr: '<w:rPr/>' }
const text = (t: string): PmNode => ({
  type: 'text',
  text: t,
  marks: [{ type: 'docTextStyle', attrs: STYLE }],
})
const paragraph = (...t: string[]): PmNode => ({
  type: 'docParagraph',
  attrs: {},
  content: t.map(text),
})

const editors: Editor[] = []
afterEach(() => {
  for (const e of editors.splice(0)) e.destroy()
})
async function createEditor(blocks: PmNode[]): Promise<Editor> {
  const { editorExtensions } = await import('../src/renderer/editor/extensions')
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
  })
  editors.push(editor)
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

function notesAccess(footnotes: NoteInfo[], endnotes: NoteInfo[] = []) {
  const state: Record<NoteKind, NoteInfo[]> = { footnote: footnotes, endnote: endnotes }
  let replaced = 0
  const access: AiNotesAccess = {
    list: (kind) => state[kind],
    add: () => '',
    remove: () => false,
    replace: (kind, id, next) => {
      replaced++
      state[kind] = state[kind].map((n) => (n.id === id ? next : n))
      return true
    },
  }
  return { access, state, replaced: () => replaced }
}

const run = (t: string, extra: Record<string, unknown> = {}) => ({ text: t, ...extra })
const richNote = (id: string, ...paras: Array<Array<ReturnType<typeof run>>>): NoteInfo => ({
  id,
  text: paras.map((p) => p.map((r) => r.text).join('')).join('\n'),
  richParas: paras,
})

const exec = (
  editor: Editor,
  name: string,
  input: Record<string, unknown>,
  access?: AiNotesAccess,
) =>
  executeTool(
    editor,
    { id: 'x', name, input },
    NUM_IDS,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    access,
  )

describe('settleTexts spacing', () => {
  it('does not put an inherited space before closing punctuation', () => {
    expect(settleTexts(['1933)', ' 으로 추정'], ['1933)', ', most likely'])).toEqual([
      '1933)',
      ', most likely',
    ])
    expect(settleTexts(['추정 ', ', 그리고'], ['is estimated', ', and'])).toEqual([
      'is estimated',
      ', and',
    ])
  })

  it('keeps whitespace the model wrote and the source had', () => {
    expect(settleTexts(['가 ', '나'], ['a ', 'b'])).toEqual(['a ', 'b'])
    expect(settleTexts(['가', ' 나'], ['a', ' b'])).toEqual(['a', ' b'])
    expect(settleTexts(['가', '나'], ['a', 'b'])).toEqual(['a', 'b'])
    expect(settleTexts(['가', '나'], ['a', ', b'])).toEqual(['a', ', b'])
  })

  it('never doubles the space between two groups', () => {
    expect(settleTexts(['가 ', ' 나'], ['a', 'b'])).toEqual(['a ', 'b'])
    expect(settleTexts(['가 ', ' 나'], ['a ', 'b'])).toEqual(['a ', 'b'])
  })
})

describe('settleTexts with empty segments and unseen gap runs', () => {
  it('a segment the model left empty does not bring back the original trailing space', () => {
    // source "in the | 1960 | 년 | 1 | 월 | 9": the model folded the date into later segments
    expect(
      settleTexts(['… ', '1960', '년 ', '1', '월 ', '9'], ['in the ', '', '', 'January', ' ', '9']),
    ).toEqual(['in the ', '', '', 'January', ' ', '9'])
    // no space before the punctuation that follows an emptied group
    expect(settleTexts(['11)도 ', '유심히 보았', '다.'], ['11, 1959)', '', '.'])).toEqual([
      '11, 1959)',
      '',
      '.',
    ])
  })

  it('an emptied group still keeps the words around it apart when nothing else does', () => {
    expect(settleTexts(['가 ', '나 ', '다'], ['a', '', 'c'])).toEqual(['a ', '', 'c'])
    expect(settleTexts(['가', '나 ', '다'], ['a', '', 'c'])).toEqual(['a', ' ', 'c'])
  })

  it('a whitespace-only run between two groups is the separator: no second space', () => {
    expect(settleTexts(['이응노는', '전주읍'], ['Lee Ungno', ' opened'], [true])).toEqual([
      'Lee Ungno',
      'opened',
    ])
    expect(settleTexts(['이응노는', '전주읍'], ['Lee Ungno ', 'opened'], [true])).toEqual([
      'Lee Ungno',
      'opened',
    ])
    // without a gap run the old rules apply
    expect(settleTexts(['이응노는', '전주읍'], ['Lee Ungno', ' opened'])).toEqual([
      'Lee Ungno',
      ' opened',
    ])
  })
})

describe('whitespace-only runs between groups (body and notes)', () => {
  it('translate_blocks does not double the space of an unseen separator run', async () => {
    const editor = await createEditor([
      {
        type: 'docParagraph',
        attrs: {},
        content: [
          text('이응노는'),
          { ...text(' '), marks: [{ type: 'docTextStyle', attrs: { ...STYLE, bold: true } }] },
          {
            ...text('전주읍에'),
            marks: [{ type: 'docTextStyle', attrs: { ...STYLE, italic: true } }],
          },
        ],
      },
    ])
    const read = await exec(editor, 'read_runs', { startBlockIndex: 0, endBlockIndex: 0 })
    const fp = JSON.parse(read.output.split('\n')[0]).fp
    const done = await exec(editor, 'translate_blocks', {
      blocks: [{ index: 0, fp, segments: ['Lee Ungno', ' opened a shop in Jeonju'] }],
    })
    expect(done.isError, done.output).toBeFalsy()
    expect(editor.state.doc.textContent).toBe('Lee Ungno opened a shop in Jeonju')
  })

  it('the same for a note whose runs have a separator run', async () => {
    const editor = await createEditor([paragraph('본문')])
    const n = notesAccess([
      richNote('1', [run('이응노는'), run(' '), run('전주읍에', { italic: true })]),
    ])
    const read = await exec(editor, 'read_runs', { notes: true }, n.access)
    const fp = JSON.parse(read.output.split('\n')[0]).fp
    const done = await exec(
      editor,
      'translate_blocks',
      { blocks: [{ note: 'footnote', id: '1', fp, segments: ['Lee Ungno', ' in Jeonju'] }] },
      n.access,
    )
    expect(done.isError, done.output).toBeFalsy()
    expect(n.state.footnote[0].text).toBe('Lee Ungno in Jeonju')
  })
})

describe('settleTexts tidies stray spaces the model wrote', () => {
  it('collapses double spaces and drops a space before , . ) ]', () => {
    expect(settleTexts(['가나', '다'], ['one  two ,', 'three .'])).toEqual(['one two,', 'three.'])
    expect(settleTexts(['가', '나'], ['(see it ', ') now'])).toEqual(['(see it', ') now'])
    expect(settleTexts(['가', '나'], ['a ', ', b'])).toEqual(['a', ', b'])
    expect(settleTexts(['가', '나'], ['a ', ' b'])).toEqual(['a ', 'b'])
  })

  it('leaves French marks, ellipses and dotted names alone', () => {
    expect(settleTexts(['가', '나'], ['Quoi ?', 'Bien ; oui : non !'])).toEqual([
      'Quoi ?',
      'Bien ; oui : non !',
    ])
    expect(settleTexts(['가'], ['wait ... then .NET and « a »'])).toEqual([
      'wait ... then .NET and « a »',
    ])
  })
})

describe('footnotes through read_runs / translate_blocks', () => {
  it('states the note counts on every body read and translate_blocks result', async () => {
    const editor = await createEditor([paragraph('본문'), paragraph('둘째')])
    const n = notes()
    const read = await exec(editor, 'read_runs', { startBlockIndex: 0, endBlockIndex: 0 }, n.access)
    expect(read.output).toMatch(/2 footnotes and 0 endnotes[^\n]*not translated[^\n]*notes:true/)
    const body = read.output.split('\n').map((l) => JSON.parse(l.startsWith('{') ? l : '{}'))
    const done = await exec(
      editor,
      'translate_blocks',
      { blocks: [{ index: 0, fp: body[0].fp, segments: ['Body'] }] },
      n.access,
    )
    expect(done.output).toMatch(/Still untranslated: 1 body block\(s\) and 3 note paragraph\(s\)/)
    expect(done.output).toMatch(/notes:true/)
  })

  it('says nothing about notes when the document has none, and reports remaining body', async () => {
    const editor = await createEditor([paragraph('본문')])
    const read = await exec(editor, 'read_runs', { startBlockIndex: 0, endBlockIndex: 0 })
    expect(read.output).not.toMatch(/footnote/)
    const fp = JSON.parse(read.output.split('\n')[0]).fp
    const done = await exec(editor, 'translate_blocks', {
      blocks: [{ index: 0, fp, segments: ['Body'] }],
    })
    expect(done.output).toMatch(/Nothing is left by this tool's own tracking/)
  })

  const notes = () =>
    notesAccess([
      richNote('1', [run('첫 '), run('각주', { italic: true }), run('입니다.')]),
      richNote('2', [run('둘째 각주.')], [run('둘째 문단.')]),
    ])

  it('lists notes with run segments and fingerprints', async () => {
    const editor = await createEditor([paragraph('본문')])
    const { access } = notes()
    const read = await exec(editor, 'read_runs', { notes: true }, access)
    expect(read.isError).toBeFalsy()
    const lines = read.output.split('\n').map((l) => JSON.parse(l))
    expect(lines[0]).toMatchObject({
      note: 'footnote',
      id: '1',
      segments: ['첫 ', '각주', '입니다.'],
    })
    expect(lines[0].fp).toBeTruthy()
    expect(lines.map((l) => [l.id, l.paragraph])).toEqual([
      ['1', undefined],
      ['2', 0],
      ['2', 1],
    ])
  })

  it('points the body read at the notes', async () => {
    const editor = await createEditor([paragraph('본문')])
    const read = await exec(
      editor,
      'read_runs',
      { startBlockIndex: 0, endBlockIndex: 0 },
      notes().access,
    )
    expect(read.output).toMatch(/notes:true/)
  })

  it('swaps the text inside the note runs and keeps their formatting', async () => {
    const editor = await createEditor([paragraph('본문')])
    const n = notes()
    const read = await exec(editor, 'read_runs', { notes: true }, n.access)
    const lines = read.output.split('\n').map((l) => JSON.parse(l))
    const done = await exec(
      editor,
      'translate_blocks',
      {
        blocks: [
          { note: 'footnote', id: '1', fp: lines[0].fp, segments: ['First ', 'note', ' here.'] },
          { note: 'footnote', id: '2', paragraph: 0, fp: lines[1].fp, segments: ['Second note.'] },
          {
            note: 'footnote',
            id: '2',
            paragraph: 1,
            fp: lines[2].fp,
            segments: ['Second paragraph.'],
          },
        ],
      },
      n.access,
    )
    expect(done.isError, done.output).toBeFalsy()
    expect(done.mutated).toBe(true)
    const first = n.state.footnote[0]
    expect(first.text).toBe('First note here.')
    expect(first.richParas![0].map((r) => [r.text, r.italic])).toEqual([
      ['First ', undefined],
      ['note', true],
      [' here.', undefined],
    ])
    expect(n.state.footnote[1].text).toBe('Second note.\nSecond paragraph.')
    expect(n.state.footnote[1].richParas).toHaveLength(2)
  })

  it('reports INCOMPLETE for a note and refuses everything on a stale fingerprint', async () => {
    const editor = await createEditor([paragraph('본문')])
    const n = notes()
    const read = await exec(editor, 'read_runs', { notes: true }, n.access)
    const lines = read.output.split('\n').map((l) => JSON.parse(l))
    const part = await exec(
      editor,
      'translate_blocks',
      { blocks: [{ note: 'footnote', id: '1', fp: lines[0].fp, segments: ['First'] }] },
      n.access,
    )
    expect(part.output).toMatch(/INCOMPLETE[\s\S]*footnote 1 \(1 of 3/)
    const before = n.replaced()
    const bad = await exec(
      editor,
      'translate_blocks',
      {
        blocks: [
          { index: 0, fp: 'stale', segments: ['Body'] },
          { note: 'footnote', id: '2', paragraph: 0, fp: lines[1].fp, segments: ['Second'] },
        ],
      },
      n.access,
    )
    expect(bad.isError).toBe(true)
    expect(n.replaced()).toBe(before)
  })

  it('refuses a note item before touching the body or any note', async () => {
    const editor = await createEditor([paragraph('본문')])
    const n = notes()
    const docBefore = editor.state.doc
    const bad = await exec(
      editor,
      'translate_blocks',
      {
        blocks: [
          { index: 0, fp: 'x', segments: ['Body'] },
          { note: 'footnote', id: '1', fp: 'stale', segments: ['a', 'b', 'c'] },
        ],
      },
      n.access,
    )
    expect(bad.isError).toBe(true)
    expect(editor.state.doc).toBe(docBefore)
    expect(n.replaced()).toBe(0)
  })

  it('falls back to one segment per paragraph for a note without display runs', async () => {
    const editor = await createEditor([paragraph('본문')])
    const n = notesAccess([{ id: '9', text: '평문 각주' }])
    const read = await exec(editor, 'read_runs', { notes: true }, n.access)
    const line = JSON.parse(read.output)
    expect(line.segments).toEqual(['평문 각주'])
    const done = await exec(
      editor,
      'translate_blocks',
      { blocks: [{ note: 'footnote', id: '9', fp: line.fp, segments: ['Plain note'] }] },
      n.access,
    )
    expect(done.isError).toBeFalsy()
    expect(n.state.footnote[0].text).toBe('Plain note')
  })
})

describe('completion check', () => {
  it('names the body paragraphs and notes that still hold the source script', async () => {
    const editor = await createEditor([paragraph('번역 안 됨'), paragraph('Already English')])
    const n = notesAccess([richNote('1', [run('각주')]), richNote('2', [run('Done')])])
    const out = await exec(
      editor,
      'read_runs',
      { checkRemaining: true, sourceLanguage: 'Korean' },
      n.access,
    )
    expect(out.isError).toBeFalsy()
    expect(out.output).toMatch(/Body blocks: 0\b/)
    expect(out.output).not.toMatch(/Body blocks: 0, 1/)
    expect(out.output).toMatch(/Notes: footnote 1\b/)
    expect(out.output).not.toMatch(/footnote 2/)
  })

  it('reports nothing left once everything was translated', async () => {
    const editor = await createEditor([paragraph('번역 안 됨')])
    const n = notesAccess([richNote('1', [run('각주')])])
    const read = JSON.parse(
      (
        await exec(editor, 'read_runs', { startBlockIndex: 0, endBlockIndex: 0 }, n.access)
      ).output.split('\n')[0],
    )
    const note = JSON.parse((await exec(editor, 'read_runs', { notes: true }, n.access)).output)
    await exec(
      editor,
      'translate_blocks',
      {
        blocks: [
          { index: 0, fp: read.fp, segments: ['Translated'] },
          { note: 'footnote', id: '1', fp: note.fp, segments: ['Note'] },
        ],
      },
      n.access,
    )
    const out = await exec(
      editor,
      'read_runs',
      { checkRemaining: true, sourceLanguage: 'ko' },
      n.access,
    )
    expect(out.output).toMatch(/Nothing left/)
  })

  it('without a source script, lists paragraphs translate_blocks has not handled', async () => {
    const editor = await createEditor([paragraph('Bonjour le monde'), paragraph('Salut')])
    const first = JSON.parse(
      (await exec(editor, 'read_runs', { startBlockIndex: 0, endBlockIndex: 0 })).output,
    )
    await exec(editor, 'translate_blocks', {
      blocks: [{ index: 0, fp: first.fp, segments: ['Hello world'] }],
    })
    const out = await exec(editor, 'read_runs', { checkRemaining: true, sourceLanguage: 'French' })
    expect(out.output).toMatch(/Body blocks: 1$/m)
  })

  it('recognises common source scripts', () => {
    expect(sourceScriptOf('ko')?.test('한')).toBe(true)
    expect(sourceScriptOf('Japanese')?.test('かな')).toBe(true)
    expect(sourceScriptOf('French')).toBeNull()
  })
})
