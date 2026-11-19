import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import JSZip from 'jszip'
import { buildAnchoredTextboxParagraphXml, parseDocx, saveDocx } from '@genoffice/docx-engine'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { blocksToPmDoc, pmDocToSavePlan, type PmNode } from '../src/renderer/editor/convert'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { textBoxNode } from '../src/renderer/ai/floating-ops'
import {
  applyRunTranslations,
  readRunGroups,
  recordHandled,
  remainingUntranslated,
  runFingerprint,
} from '../src/renderer/ai/translate-runs'
import { executeTool } from '../src/renderer/ai/tools'

/**
 * Translation and anchored text boxes (docs/plans/ocr-box-placement-implementation.md, Task 1).
 * Boxes placed over a picture by OCR are anchored text boxes, and the translation must read
 * and write their paragraphs. The editor holds a text box as a `docProtected` block whose
 * `textboxes` attribute carries the display paragraphs (runs), which the save path patches
 * back into the original XML.
 */

const liveEditors: Editor[] = []
function createEditor(content: unknown[]): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: { type: 'doc', content } as never,
  })
  liveEditors.push(editor)
  return editor
}
afterEach(() => {
  for (const editor of liveEditors.splice(0)) editor.destroy()
})

const body = (t: string) => ({
  type: 'docParagraph',
  attrs: { docxIndex: null },
  content: [{ type: 'text', text: t }],
})

type Run = { text: string; bold?: boolean; sizeHalfPoints?: number; rawRPr?: string }
type Box = { paras: { runs: Run[] }[]; readOnly?: boolean }
const boxBlock = (boxes: Box[]) => ({
  type: 'docProtected',
  attrs: {
    docxIndex: null,
    blockType: 'passthrough',
    label: 'Text box',
    previewText: '',
    genXml: '',
    textboxes: boxes,
  },
})
const para = (...runs: Run[]) => ({ runs })

const boxesOf = (editor: Editor, index: number): Box[] =>
  editor.state.doc.child(index).attrs.textboxes as Box[]
const textsOf = (box: Box) => box.paras.map((p) => p.runs.map((r) => r.text).join('|'))

describe('translation and anchored text boxes', () => {
  it('translation reads the paragraphs of an anchored text box', () => {
    const box = textBoxNode({ text: 'BOX TEXT', width: 120, height: 40, x: 10, y: 10 })
    if ('error' in box) throw new Error(box.error)
    const editor = createEditor([body('Body text'), box.node])

    const read = readRunGroups(editor, 0, editor.state.doc.childCount - 1)
    const segments = read.flatMap((entry) => ('segments' in entry ? entry.segments : []))

    expect(segments).toContain('Body text')
    expect(segments).toContain('BOX TEXT')
  })

  it('lists each text box paragraph with box and paragraph numbers and a fingerprint', () => {
    const editor = createEditor([
      body('Body'),
      boxBlock([
        { paras: [para({ text: 'A one' }), para({ text: 'A two' })] },
        { paras: [para({ text: 'B' }, { text: ' c', bold: true })] },
      ]),
    ])

    const entries = readRunGroups(editor, 1, 1)

    expect(entries).toEqual([
      { index: 1, box: 0, paragraph: 0, fp: runFingerprint(['A one']), segments: ['A one'] },
      { index: 1, box: 0, paragraph: 1, fp: runFingerprint(['A two']), segments: ['A two'] },
      { index: 1, box: 1, paragraph: 0, fp: runFingerprint(['B', ' c']), segments: ['B', ' c'] },
    ])
  })

  it('skips a read-only text box with a reason and lists nothing for an empty box', () => {
    const editor = createEditor([
      boxBlock([
        { paras: [para({ text: 'table inside' })], readOnly: true },
        { paras: [para({ text: '   ' })] },
        { paras: [] },
      ]),
    ])

    expect(readRunGroups(editor, 0, 0)).toEqual([{ index: 0, box: 0, skip: 'read-only text box' }])
  })

  it('translate_blocks writes the translation into the box runs and keeps the run formatting', () => {
    const editor = createEditor([
      boxBlock([
        {
          paras: [
            para(
              { text: 'Hallo', bold: true, sizeHalfPoints: 24, rawRPr: '<w:rPr><w:b/></w:rPr>' },
              { text: 'Welt' },
            ),
          ],
        },
      ]),
    ])
    const [entry] = readRunGroups(editor, 0, 0)

    const outcome = applyRunTranslations(editor, [
      { index: 0, box: 0, paragraph: 0, fp: entry!.fp, segments: ['Hello', 'World'] },
    ])

    expect(outcome.ok).toBe(true)
    const runs = boxesOf(editor, 0)[0]!.paras[0]!.runs
    expect(runs.map((r) => r.text)).toEqual(['Hello', 'World'])
    expect(runs[0]).toMatchObject({
      bold: true,
      sizeHalfPoints: 24,
      rawRPr: '<w:rPr><w:b/></w:rPr>',
    })
    if (outcome.ok) expect(outcome.reports[0]).toMatchObject({ index: 0, box: 0, changed: 2 })
  })

  it('skips a text box paragraph whose fingerprint changed', () => {
    const editor = createEditor([body('Hallo'), boxBlock([{ paras: [para({ text: 'Welt' })] }])])
    const [bodyEntry] = readRunGroups(editor, 0, 0)

    const outcome = applyRunTranslations(editor, [
      { index: 0, fp: bodyEntry!.fp, segments: ['Hello'] },
      { index: 1, box: 0, paragraph: 0, fp: 'stale', segments: ['World'] },
    ])

    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.stale).toHaveLength(1)
    expect(editor.state.doc.child(0).textContent).toBe('Hello')
    expect(textsOf(boxesOf(editor, 1)[0]!)).toEqual(['Welt'])
  })

  it('a translated text box paragraph undoes before the preceding body translation', () => {
    const editor = createEditor([body('Hallo'), boxBlock([{ paras: [para({ text: 'Welt' })] }])])
    const [bodyEntry] = readRunGroups(editor, 0, 0)
    const [boxEntry] = readRunGroups(editor, 1, 1)

    applyRunTranslations(editor, [
      { index: 0, fp: bodyEntry!.fp, segments: ['Hello'] },
      { index: 1, box: 0, paragraph: 0, fp: boxEntry!.fp, segments: ['World'] },
    ])
    expect(textsOf(boxesOf(editor, 1)[0]!)).toEqual(['World'])

    editor.commands.undo()
    expect(editor.state.doc.child(0).textContent).toBe('Hello')
    expect(textsOf(boxesOf(editor, 1)[0]!)).toEqual(['Welt'])
    editor.commands.undo()
    expect(editor.state.doc.child(0).textContent).toBe('Hallo')
    expect(textsOf(boxesOf(editor, 1)[0]!)).toEqual(['Welt'])
  })

  it('remainingUntranslated lists untranslated text box paragraphs and drops them once translated', () => {
    const editor = createEditor([boxBlock([{ paras: [para({ text: '안녕하세요' })] }])])
    expect(remainingUntranslated(editor, undefined, 'ko').body).toEqual(['0 (box 0 paragraph 0)'])

    const [entry] = readRunGroups(editor, 0, 0)
    const outcome = applyRunTranslations(editor, [
      { index: 0, box: 0, paragraph: 0, fp: entry!.fp, segments: ['Hello'] },
    ])
    if (outcome.ok) recordHandled(editor, outcome.reports)

    expect(remainingUntranslated(editor, undefined, 'ko').body).toEqual([])
  })

  it('revise_blocks and add_bilingual refuse a box item with a clear message', async () => {
    const editor = createEditor([boxBlock([{ paras: [para({ text: 'Welt' })] }])])
    const [entry] = readRunGroups(editor, 0, 0)
    const blocks = [{ index: 0, box: 0, paragraph: 0, fp: entry!.fp, segments: ['World'] }]

    for (const name of ['revise_blocks', 'add_bilingual']) {
      const result = await executeTool(
        editor,
        { id: 't', name, input: { blocks, layout: 'below' } } as never,
        { bullet: null, ordered: null },
      )
      expect(result.isError).toBe(true)
      expect(result.output).toMatch(/text box/i)
    }
    expect(textsOf(boxesOf(editor, 0)[0]!)).toEqual(['Welt'])
  })
  it('a translated text box paragraph is written into the saved document', async () => {
    const boxXml = buildAnchoredTextboxParagraphXml({
      anchor: 'paragraph',
      xEmu: 0,
      yEmu: 0,
      widthEmu: 1500000,
      heightEmu: 500000,
      paragraphs: [{ runs: [{ text: 'Hallo Welt' }] }],
      id: 101,
    })
    const source = await buildDocx({
      bodyXml: '<w:p><w:r><w:t>Body</w:t></w:r></w:p>' + boxXml,
    })
    const parsed = await parseDocx(source)
    const editor = createEditor(blocksToPmDoc(parsed.blocks).content as unknown[])

    const entry = readRunGroups(editor, 0, editor.state.doc.childCount - 1).find(
      (e) => e.box !== undefined,
    )
    expect(entry?.segments).toEqual(['Hallo Welt'])
    const outcome = applyRunTranslations(editor, [
      {
        index: entry!.index,
        box: entry!.box,
        paragraph: entry!.paragraph,
        fp: entry!.fp,
        segments: ['Hello World'],
      },
    ])
    expect(outcome.ok).toBe(true)

    const plan = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
    const out = await saveDocx(parsed, plan.saveBlocks)
    const xml = await (await JSZip.loadAsync(out)).file('word/document.xml')!.async('string')
    expect(xml).toContain('Hello World')
    expect(xml).not.toContain('Hallo Welt')
  })
  it('with revision tracking on, a text box paragraph is skipped and reported, not a failure of the batch', () => {
    const editor = createEditor([body('Hallo'), boxBlock([{ paras: [para({ text: 'Welt' })] }])])
    const [bodyEntry] = readRunGroups(editor, 0, 0)
    const [boxEntry] = readRunGroups(editor, 1, 1)

    const outcome = applyRunTranslations(
      editor,
      [
        { index: 0, fp: bodyEntry!.fp, segments: ['Hello'] },
        { index: 1, box: 0, paragraph: 0, fp: boxEntry!.fp, segments: ['World'] },
      ],
      { author: 'AI Assistant' },
    )

    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.reports).toHaveLength(1)
      expect(outcome.skippedBoxes).toHaveLength(1)
      expect(outcome.skippedBoxes[0]).toMatch(/tracked changes/)
    }
    expect(textsOf(boxesOf(editor, 1)[0]!)).toEqual(['Welt'])
  })

  it('refuses a call that holds only text box items while tracking, saying why', () => {
    const editor = createEditor([boxBlock([{ paras: [para({ text: 'Welt' })] }])])
    const [entry] = readRunGroups(editor, 0, 0)

    const outcome = applyRunTranslations(
      editor,
      [{ index: 0, box: 0, paragraph: 0, fp: entry!.fp, segments: ['World'] }],
      { author: 'AI Assistant' },
    )

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.errors.join(' ')).toMatch(/tracked changes/)
  })

  it('remainingUntranslated leaves text box paragraphs out while tracking, so the check can finish', () => {
    const editor = createEditor([boxBlock([{ paras: [para({ text: '안녕하세요' })] }])])
    expect(remainingUntranslated(editor, undefined, 'ko').body).toEqual(['0 (box 0 paragraph 0)'])
    expect(remainingUntranslated(editor, undefined, 'ko', { tracking: true }).body).toEqual([])
  })
})
