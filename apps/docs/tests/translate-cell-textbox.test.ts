import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import JSZip from 'jszip'
import { buildAnchoredTextboxParagraphXml, parseDocx, saveDocx } from '@genoffice/docx-engine'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { placeOcrText } from '../../shell/src/main/translate/ocr-placement'
import { executeTool } from '../src/renderer/ai/tools'
import { assignTableSegments } from '../src/renderer/editor/cell-box-segments'
import { blocksToPmDoc, pmDocToSavePlan, type PmNode } from '../src/renderer/editor/convert'
import { editorExtensions } from '../src/renderer/editor/extensions'
import {
  applyRunTranslations,
  readRunGroups,
  remainingUntranslated,
} from '../src/renderer/ai/translate-runs'

/**
 * Text boxes inside table cells (the boxes OCR puts over a picture in a cell). The editor shows
 * them but treats them as display only, so this file pins the added path: the load notes which
 * text segment of the table XML each box is, the translation reads and writes those boxes, and the
 * save writes the new text back into the original table bytes (both the drawing and its fallback).
 */

const box = (id: number, text: string) =>
  buildAnchoredTextboxParagraphXml({
    anchor: 'paragraph',
    xEmu: 0,
    yEmu: -100000,
    widthEmu: 1500000,
    heightEmu: 400000,
    paragraphs: [{ runs: [{ text }] }],
    id,
    fillHex: 'FFFFFF',
    wrap: 'none',
    holderLineTwips: 20,
  })
const cell = (text: string, ...boxes: string[]) =>
  `<w:tc><w:p><w:r><w:t>${text}</w:t></w:r></w:p>${boxes.join('')}</w:tc>`
const table = (...cells: string[]) =>
  `<w:tbl><w:tblPr/><w:tblGrid>${cells.map(() => '<w:gridCol w:w="3000"/>').join('')}</w:tblGrid><w:tr>${cells.join('')}</w:tr></w:tbl>`

describe('assignTableSegments', () => {
  it('numbers each box by its text segment in the whole table, also for equal texts', () => {
    const xml = table(
      cell('A', box(1, 'Same'), box(2, 'Same')),
      cell('B', box(3, 'Other')),
      cell('C', box(4, 'Last')),
    )
    expect(assignTableSegments(xml, ['Same', 'Same', 'Other', 'Last'])).toEqual([0, 1, 2, 3])
  })

  it('leaves a box without text unnumbered and keeps the others in order', () => {
    const xml = table(cell('A', box(1, 'First')), cell('B', box(2, 'Second')))
    expect(assignTableSegments(xml, ['First', '', 'Second'])).toEqual([0, undefined, 1])
  })

  it('gives up on a text the table does not hold instead of guessing', () => {
    const xml = table(cell('A', box(1, 'Real')))
    expect(assignTableSegments(xml, ['Something else'])).toEqual([undefined])
  })

  it('does nothing for a table without boxes', () => {
    expect(assignTableSegments(table(cell('A')), ['x'])).toEqual([undefined])
  })
})

const live: Editor[] = []
afterEach(() => live.splice(0).forEach((e) => e.destroy()))

async function open(...cells: string[]) {
  const bytes = await buildDocx({
    bodyXml: `<w:p><w:r><w:t>Before</w:t></w:r></w:p>${table(...cells)}<w:p/>`,
  })
  const parsed = await parseDocx(bytes)
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: blocksToPmDoc(parsed.blocks) as never,
  })
  live.push(editor)
  return { parsed, editor }
}
const tableIndex = 1
const boxEntries = (editor: Editor) =>
  readRunGroups(editor, 0, editor.state.doc.childCount - 1).filter((e) => e.box !== undefined)
async function saved(parsed: Awaited<ReturnType<typeof parseDocx>>, editor: Editor) {
  const plan = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
  const out = await saveDocx(parsed, plan.saveBlocks)
  const xml = await (await JSZip.loadAsync(out)).file('word/document.xml')!.async('string')
  return { plan, xml, out }
}
const wt = (xml: string) => [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1])

describe('translating text boxes inside table cells', () => {
  it('lists the paragraphs of each cell box with the table-wide box number', async () => {
    const { editor } = await open(cell('A', box(1, 'BOX ONE')), cell('B', box(2, 'BOX TWO')))

    expect(boxEntries(editor)).toEqual([
      expect.objectContaining({ index: tableIndex, box: 0, paragraph: 0, segments: ['BOX ONE'] }),
      expect.objectContaining({ index: tableIndex, box: 1, paragraph: 0, segments: ['BOX TWO'] }),
    ])
  })

  it('reports source text in a nested-table drawing when the live editor cannot write that box', async () => {
    const inner = table(cell('Fixed', box(7, '내부 상자')))
    const { editor } = await open(cell('Outer', inner, '<w:p/>'))
    const report = remainingUntranslated(editor, undefined, 'ko')
    expect(report.progress).toEqual({ done: 0, total: 1 })
    expect(report.blocked).toHaveLength(1)
    expect(report.blocked![0]).toContain('nested table 0')
  })

  it('supplies exact addresses and fingerprints for only the pending editable runs in a retry', async () => {
    const { editor } = await open(
      cell('본문', box(9, '같은 글'), box(10, '같은 글')),
      cell('Already English'),
    )
    const ids = { bullet: null, ordered: null }
    const check = () =>
      executeTool(
        editor,
        {
          id: 'r',
          name: 'read_runs',
          input: { checkRemaining: true, sourceLanguage: 'ko', includePendingRuns: true },
        },
        ids,
      )
    const rows = (text: string) =>
      text
        .split('\n')
        .filter((l) => l.startsWith('{'))
        .map((l) => JSON.parse(l))
    const before = await check()
    const entries = rows(before.output)
    expect(before.translationProgress).toEqual({ done: 0, total: 3 })
    expect(entries).toEqual([
      { index: 1, paragraph: 0, fp: expect.any(String), segments: ['본문'] },
      { index: 1, box: 0, paragraph: 0, fp: expect.any(String), segments: ['같은 글'] },
      { index: 1, box: 1, paragraph: 0, fp: expect.any(String), segments: ['같은 글'] },
    ])
    const change = await executeTool(
      editor,
      {
        id: 't',
        name: 'translate_blocks',
        input: {
          blocks: [{ ...entries[1], segments: ['First box'] }],
        },
      },
      ids,
    )
    expect(change.isError).toBeFalsy()
    const after = await check()
    expect(after.translationProgress).toEqual({ done: 1, total: 3 })
    expect(rows(after.output)).toEqual([entries[0], entries[2]])
  })

  it('writes a translation into one cell box and leaves the other and the cell text alone', async () => {
    const { editor } = await open(cell('A', box(1, 'BOX ONE')), cell('B', box(2, 'BOX TWO')))
    const [, second] = boxEntries(editor)

    const outcome = applyRunTranslations(editor, [
      { index: tableIndex, box: 1, paragraph: 0, fp: second!.fp, segments: ['TWO TRANSLATED'] },
    ])

    expect(outcome.ok).toBe(true)
    expect(boxEntries(editor).map((e) => e.segments)).toEqual([['BOX ONE'], ['TWO TRANSLATED']])
    expect(editor.state.doc.child(tableIndex).textContent).toContain('A')
  })

  it('writes the translated cell box into the saved document, both the drawing and its fallback', async () => {
    const { parsed, editor } = await open(
      cell('A', box(1, 'BOX ONE')),
      cell('B', box(2, 'BOX TWO')),
    )
    const [, second] = boxEntries(editor)
    applyRunTranslations(editor, [
      { index: tableIndex, box: 1, paragraph: 0, fp: second!.fp, segments: ['TWO TRANSLATED'] },
    ])

    const { xml } = await saved(parsed, editor)

    expect(wt(xml)).toEqual([
      'Before',
      'A',
      'BOX ONE',
      'BOX ONE',
      'B',
      'TWO TRANSLATED',
      'TWO TRANSLATED',
    ])
  })

  it('keeps the original table bytes when nothing was edited', async () => {
    const { parsed, editor } = await open(
      cell('A', box(1, 'BOX ONE')),
      cell('B', box(2, 'BOX TWO')),
    )

    const { plan } = await saved(parsed, editor)

    const kinds = plan.saveBlocks.map((b) => b.kind)
    expect(kinds).not.toContain('xml')
  })

  it('writes a cell text and a cell box translated in the same call', async () => {
    const { parsed, editor } = await open(
      cell('A', box(1, 'BOX ONE')),
      cell('B', box(2, 'BOX TWO')),
    )
    const read = readRunGroups(editor, tableIndex, tableIndex)
    const cellA = read.find((e) => e.box === undefined && e.segments?.[0] === 'A')!
    const [first] = boxEntries(editor)

    const outcome = applyRunTranslations(editor, [
      { index: tableIndex, paragraph: cellA.paragraph!, fp: cellA.fp, segments: ['A TRANSLATED'] },
      { index: tableIndex, box: 0, paragraph: 0, fp: first!.fp, segments: ['ONE TRANSLATED'] },
    ])
    expect(outcome.ok).toBe(true)

    const { xml } = await saved(parsed, editor)
    expect(wt(xml)).toEqual([
      'Before',
      'A TRANSLATED',
      'ONE TRANSLATED',
      'ONE TRANSLATED',
      'B',
      'BOX TWO',
      'BOX TWO',
    ])
  })

  it('skips cell boxes while revision tracking is on, like other text boxes', async () => {
    const { editor } = await open(cell('A', box(1, 'BOX ONE')))
    const [entry] = boxEntries(editor)

    const outcome = applyRunTranslations(
      editor,
      [{ index: tableIndex, box: 0, paragraph: 0, fp: entry!.fp, segments: ['X'] }],
      { author: 'AI Assistant' },
    )

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.errors.join(' ')).toMatch(/tracked changes/)
  })

  it('counts cell boxes in the remaining untranslated check', async () => {
    const { editor } = await open(cell('A', box(1, '안녕하세요')))
    expect(remainingUntranslated(editor, undefined, 'ko').body).toContain(
      `${tableIndex} (box 0 paragraph 0)`,
    )
  })

  it('reads, translates and saves the boxes that OCR placed over a picture in a cell', async () => {
    const picture =
      '<w:r><w:drawing><wp:inline><wp:extent cx="3000000" cy="1500000"/><wp:docPr id="7" name="P"/>' +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:pic><pic:blipFill><a:blip r:embed="rId10"/></pic:blipFill></pic:pic></a:graphicData>' +
      '</a:graphic></wp:inline></w:drawing></w:r>'
    const source = await buildDocx({
      withImage: true,
      bodyXml:
        '<w:p><w:r><w:t>Intro</w:t></w:r></w:p>' +
        '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="6000"/></w:tblGrid><w:tr><w:tc>' +
        `<w:p>${picture}</w:p></w:tc></w:tr></w:tbl><w:p/>`,
    })
    const boxes = [
      { x: 0.1, y: 0.2, w: 0.3, h: 0.1, fontHeight: 0.08, text: 'Shop name' },
      { x: 0.5, y: 0.6, w: 0.3, h: 0.1, fontHeight: 0.08, text: 'Opening hours' },
    ]
    const placed = await placeOcrText(
      source,
      'docx',
      [
        {
          index: 1,
          text: 'Shop name\nOpening hours',
          location: 'document.xml · ¶2',
          part: 'word/document.xml',
          relId: 'rId10',
        },
      ],
      { kind: 'docx-image-boxes', images: [{ index: 1, boxes }] },
    )
    // the engine puts the boxes into the cell, and the picture and the cell are untouched
    const parsed = await parseDocx(placed)
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: blocksToPmDoc(parsed.blocks) as never,
    })
    live.push(editor)

    const entries = boxEntries(editor)
    expect(entries.map((e) => e.segments)).toEqual([['Shop name'], ['Opening hours']])
    const outcome = applyRunTranslations(
      editor,
      entries.map((e, i) => ({
        index: e.index,
        box: e.box!,
        paragraph: 0,
        fp: e.fp,
        segments: [['상호', '영업시간'][i]!],
      })),
    )
    expect(outcome.ok).toBe(true)

    const { xml } = await saved(parsed, editor)
    expect(wt(xml).filter((t) => t !== '')).toEqual([
      'Intro',
      '상호',
      '상호',
      '영업시간',
      '영업시간',
    ])
    expect(xml).toContain('r:embed="rId10"')
  })
})
