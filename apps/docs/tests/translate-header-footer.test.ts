import { afterEach, expect, it } from 'vitest'
import JSZip from 'jszip'
import { Editor } from '@tiptap/core'
import { parseDocx, readSections, saveDocx, type ParsedDocFull } from '@genoffice/docx-engine'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { editKey, hfSaveOptions, type HfSectionState } from '../src/renderer/hf-sections'
import { executeTool, type AiHeaderFooterAccess } from '../src/renderer/ai/tools'
import { hfStories, readHfStoryRuns } from '../src/renderer/ai/hf-translation'

function rig(parsed: ParsedDocFull) {
  let state: HfSectionState = { sections: readSections(parsed), parsed, edits: {}, links: {} }
  const stories: NonNullable<AiHeaderFooterAccess['stories']> = {
    writable: () => true,
    list: () => hfStories(state),
    set: ({ owner, kind, view }, next) => {
      state = {
        ...state,
        edits: {
          ...state.edits,
          [editKey(state.sections[owner]!.lastBlockIndex, kind, view)]: next,
        },
      }
    },
  }
  const hf: AiHeaderFooterAccess = {
    stories,
    set: () => null,
    read: () => ({
      header: '',
      footer: '',
      headerFirst: null,
      footerFirst: null,
      headerEven: null,
      footerEven: null,
      titlePg: true,
      evenOddHf: true,
      multiSection: false,
    }),
  }
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
  })
  after.push(editor)
  const call = (name: string, input: Record<string, unknown>, tracking = false) =>
    executeTool(
      editor,
      { name, input, id: 'a' },
      { bullet: '1', ordered: '2' },
      tracking ? { author: 'Reviewer' } : undefined,
      undefined,
      undefined,
      undefined,
      hf,
    )
  return {
    get state() {
      return state
    },
    stories,
    editor,
    call,
  }
}
const after: Editor[] = []
afterEach(() => after.splice(0).forEach((e) => e.destroy()))
const text = (t: string) => `<w:r><w:rPr><w:b/></w:rPr><w:t>${t}</w:t></w:r>`
const field =
  '<w:fldSimple w:instr=" PAGE \\* ROMAN "><w:r><w:rPr><w:i/></w:rPr><w:t>IV</w:t></w:r></w:fldSimple>'
const dynamic =
  '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> STYLEREF Title </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
  text('자동 결과') +
  '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
const header =
  '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="5000"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:gridSpan w:val="1"/></w:tcPr><w:p>' +
  text('머리글') +
  field +
  dynamic +
  '</w:p></w:tc></w:tr></w:tbl>'
it('batches default/first/even stories, preserves the original field bytes and native table, and undoes individual units', async () => {
  const bytes = await buildDocx({
    bodyXml: '<w:p/>',
    headerXml: header,
    footerXml: '<w:p>' + text('바닥글') + '</w:p>',
  })
  const initial = await parseDocx(bytes)
  const withVariants = await saveDocx(initial, [{ kind: 'original', docxIndex: 0 }], {
    headerFirst: { text: '첫 장' },
    footerEven: { text: '짝수' },
    titlePg: true,
    evenAndOddHeaders: true,
  })
  const parsed = await parseDocx(withVariants)
  const harness = rig(parsed)
  const { stories, editor, call } = harness
  const initialCheck = await call('read_runs', { sourceLanguage: 'ko', checkRemaining: true })
  expect(initialCheck.translationProgress).toEqual({ done: 0, total: 4 })
  const read = await call('read_runs', { headerFooters: true })
  const units = read.output
    .split('\n')
    .map((line) => JSON.parse(line) as ReturnType<typeof readHfStoryRuns>[number])
  expect(units.flatMap((u) => u.segments).sort()).toEqual(
    ['머리글', '첫 장', '바닥글', '짝수'].sort(),
  )
  const translated = await call('translate_blocks', {
    blocks: units.map((u) => ({ ...u, segments: ['English ' + u.paragraph] })),
  })
  expect(translated.isError).toBeFalsy()
  expect(translated.translationProgress).toEqual({ done: 4, total: 4 })
  const checked = await call('read_runs', { checkRemaining: true })
  expect(checked.translationProgress).toEqual({ done: 4, total: 4 })
  const saved = await saveDocx(
    parsed,
    [{ kind: 'original', docxIndex: 0 }],
    hfSaveOptions(harness.state),
  )
  const origXml = await (
    await JSZip.loadAsync(withVariants)
  )
    .file('word/header1.xml')!
    .async('string')
  const xml = await (await JSZip.loadAsync(saved)).file('word/header1.xml')!.async('string')
  expect(xml).toEqual(
    origXml.replace('<w:t>머리글</w:t>', '<w:t xml:space="preserve">English 0</w:t>'),
  )
  expect(readHfStoryRuns(rig(await parseDocx(saved)).stories).map((u) => u.segments)).toEqual(
    units.map(() => ['English 0']),
  )
  expect(editor.commands.undo()).toBe(true)
  expect((await call('read_runs', { checkRemaining: true })).translationProgress).toEqual({
    done: 3,
    total: 4,
  })
  expect(editor.commands.redo()).toBe(true)
  expect(readHfStoryRuns(stories)).toHaveLength(4)
})
it('keeps the original header in a bilingual pass, respects stale reads and read-only protection', async () => {
  const { stories, call } = rig(
    await parseDocx(
      await buildDocx({ bodyXml: '<w:p/>', headerXml: '<w:p>' + text('보고서') + '</w:p>' }),
    ),
  )
  const [unit] = readHfStoryRuns(stories)
  const translate = (fp: string) =>
    call('translate_blocks', {
      keepOriginal: true,
      blocks: [{ ...unit, fp, segments: ['Report'] }],
    })
  expect((await call('read_runs', { headerFooters: true }, true)).output).toContain(
    '"readOnly":true',
  )
  expect(
    (await call('translate_blocks', { blocks: [{ ...unit, segments: ['Report'] }] }, true)).isError,
  ).toBe(true)
  expect(
    (await call('read_runs', { checkRemaining: true, sourceLanguage: 'ko' }, true))
      .translationProgress,
  ).toEqual({ done: 0, total: 1 })
  stories.writable = () => false
  expect((await translate(unit!.fp)).isError).toBe(true)
  stories.writable = () => true
  expect((await translate(unit!.fp)).mutated).toBe(true)
  expect(readHfStoryRuns(stories)[0]?.segments).toEqual(['보고서 (Report)'])
  expect((await translate(unit!.fp)).mutated).toBe(false)
})
