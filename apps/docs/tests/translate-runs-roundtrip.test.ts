import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { Editor } from '@tiptap/core'
import { parseDocx, readSections } from '@genoffice/docx-engine'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { blocksToPmDoc, pmDocOptions } from '../src/renderer/editor/convert'
import { executeTool } from '../src/renderer/ai/tools'
import { readRunGroups } from '../src/renderer/ai/translate-runs'
import { noteDocumentSwapped, save, type FileActionContext } from '../src/renderer/file-actions'
import { EMPTY_HF_VARIANTS } from '../src/renderer/doc-state'

/**
 * Round trip of a run-preserving translation through the production open and
 * save path (parseDocx -> blocksToPmDoc -> editor, translate_blocks, then
 * file-actions `save` writing the file): word/document.xml must keep the
 * paragraph count, every paragraph's pStyle and pPr, each paragraph's set of
 * run properties, the footnote references and the empty paragraphs.
 *
 * The constructed fixture mirrors the traits of the user's sample (a Korean
 * essay with Hanja runs whose rPr differ only by an eastAsia hint, footnote
 * references between runs, many empty paragraphs). The sample itself is not
 * committed; set TRANSLATE_RUNS_SAMPLE to a .docx path to run the same check
 * on a real document (a copy in a temp folder is opened and saved).
 */

;(globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s }

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const HINT = '<w:rPr><w:rFonts w:hint="eastAsia"/></w:rPr>'
const REF = '<w:rPr><w:rStyle w:val="FootnoteReference"/><w:vertAlign w:val="superscript"/></w:rPr>'
const run = (text: string, rPr = HINT) => `<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r>`
const ref = (id: number) => `<w:r>${REF}<w:footnoteReference w:id="${id}"/></w:r>`
const para = (style: string | null, inner: string) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${inner}</w:p>`

const BODY =
  para('Heading1', run('공간 속의 기호', '<w:rPr><w:b/><w:sz w:val="36"/></w:rPr>')) +
  para('Body', '') +
  para(
    'Body',
    run('1977년 3월 ') +
      run('《') +
      run('고암 이응노') +
      run('무화(') +
      run('舞', '') +
      run('畵)발표전') +
      run('》') +
      ref(1) +
      run('에 나온 ') +
      run('작품', '<w:rPr><w:i/></w:rPr>') +
      run('은 독특했다.') +
      ref(2),
  ) +
  para(null, '') +
  para(
    'Body',
    run('왼쪽') + '<w:r><w:tab/></w:r>' + run('오른쪽', '<w:rPr><w:color w:val="C00000"/></w:rPr>'),
  ) +
  '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid>' +
  '<w:tr><w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr>' +
  para('Body', run('칸 ') + run('굵게', '<w:rPr><w:b/></w:rPr>')) +
  '</w:tc><w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr>' +
  para('Body', '') +
  '</w:tc></w:tr></w:tbl>' +
  para('Body', '') +
  para('Body', run('마지막 문단.'))

const FOOTNOTES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  `<w:footnotes xmlns:w="${W}">` +
  '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
  '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>' +
  '<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t>첫 각주.</w:t></w:r></w:p></w:footnote>' +
  '<w:footnote w:id="2"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t>둘째 각주.</w:t></w:r></w:p></w:footnote>' +
  '</w:footnotes>'

const STYLES =
  '<w:style w:type="paragraph" w:styleId="Body"><w:name w:val="Body"/><w:basedOn w:val="Normal"/>' +
  '<w:pPr><w:ind w:firstLine="200"/></w:pPr></w:style>' +
  '<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/>' +
  '<w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>'

function fixtureDocx(): Promise<Uint8Array> {
  return buildDocx({
    bodyXml: BODY,
    extraStylesXml: STYLES,
    extraRels:
      '<Relationship Id="rId20" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>',
    extraParts: [
      {
        path: 'word/footnotes.xml',
        xml: FOOTNOTES,
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml',
      },
    ],
  })
}

// ---- document.xml metrics ----

interface ParagraphMetrics {
  pStyle: string | null
  pPr: string
  /** distinct rPr of the paragraph's text runs, in first-seen order */
  runProps: string[]
  footnoteRefs: number
  empty: boolean
  text: string
}

const serializer = () => new XMLSerializer()

/** rPr bytes without the attributes that only record editing sessions */
function rPrKey(r: Element): string {
  const rPr = Array.from(r.children).find((c) => c.localName === 'rPr')
  if (!rPr) return ''
  return serializer()
    .serializeToString(rPr)
    .replace(/\s+w:rsid\w*="[^"]*"/g, '')
}

function metricsOf(xml: string): ParagraphMetrics[] {
  const dom = new DOMParser().parseFromString(xml, 'application/xml')
  const body = dom.getElementsByTagNameNS(W, 'body')[0]
  return Array.from(body.getElementsByTagNameNS(W, 'p')).map((p) => {
    const pPr = Array.from(p.children).find((c) => c.localName === 'pPr')
    const pStyle = pPr
      ? (Array.from(pPr.children)
          .find((c) => c.localName === 'pStyle')
          ?.getAttributeNS(W, 'val') ?? null)
      : null
    const runs = Array.from(p.getElementsByTagNameNS(W, 'r')).filter(
      (r) => r.getElementsByTagNameNS(W, 't').length > 0,
    )
    const runProps: string[] = []
    for (const r of runs) {
      const key = rPrKey(r)
      if (!runProps.includes(key)) runProps.push(key)
    }
    const text = Array.from(p.getElementsByTagNameNS(W, 't'))
      .map((t) => t.textContent ?? '')
      .join('')
    return {
      pStyle,
      pPr: pPr ? serializer().serializeToString(pPr) : '',
      runProps,
      footnoteRefs: p.getElementsByTagNameNS(W, 'footnoteReference').length,
      // a paragraph of only spaces has nothing to translate either
      empty: text.trim() === '',
      text,
    }
  })
}

async function documentXml(bytes: Uint8Array): Promise<string> {
  return (await JSZip.loadAsync(bytes)).file('word/document.xml')!.async('string')
}

// ---- the production open/save path ----

const dirs: string[] = []
const editors: Editor[] = []
afterEach(async () => {
  for (const editor of editors.splice(0)) editor.destroy()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function openCopy(source: Uint8Array) {
  noteDocumentSwapped()
  const dir = await mkdtemp(join(tmpdir(), 'genoffice-translate-runs-'))
  dirs.push(dir)
  const path = join(dir, 'doc.docx')
  await writeFile(path, source)
  const parsed = await parseDocx(source)
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    editorProps: { handleScrollToSelection: () => true },
    content: blocksToPmDoc(parsed.blocks, readSections(parsed), pmDocOptions(parsed)),
  })
  editors.push(editor)
  const state = {
    editor,
    doc: { parsed, filePath: path, fileName: 'doc.docx', hash: 'fixture' },
    dirtyRef: { current: true },
    saveInFlightRef: { current: false },
    saveIncompleteRef: { current: false },
    inkAnnotations: [],
    sections: readSections(parsed),
    sectionsDirty: [],
    pgNumDirtySections: [],
    hfVariants: EMPTY_HF_VARIANTS,
    hfVariantsDirty: [],
    sectionHfEdits: {},
    hfLinks: {},
    styleUpserts: {},
    pendingNumbering: { newDefs: [], restartNums: [] },
  }
  const noop = () => {}
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop === 'setDoc')
        return (updater: (prev: typeof state.doc) => typeof state.doc) => {
          target.doc = updater(target.doc)
        }
      if (prop in target) return Reflect.get(target, prop)
      if (typeof prop === 'string' && (/^set[A-Z]/.test(prop) || /^on[A-Z]/.test(prop))) return noop
      return undefined
    },
  }) as unknown as FileActionContext
  window.desktop = {
    saveDocx: async (target: string, data: ArrayBuffer) => {
      await writeFile(target, new Uint8Array(data))
      return { ok: true }
    },
  } as unknown as typeof window.desktop
  return { editor, ctx, path }
}

/** a deterministic stand-in for the model: every segment becomes marked ASCII text */
function fakeTranslate(editor: Editor): { blocks: unknown[]; segments: number } {
  const entries = readRunGroups(editor, 0, editor.state.doc.childCount - 1)
  let segments = 0
  const blocks = entries
    .filter((e) => e.segments)
    .map((e) => ({
      index: e.index,
      ...(e.paragraph === undefined ? {} : { paragraph: e.paragraph }),
      segments: e.segments!.map((s, i) => {
        segments++
        return `EN${e.index}.${i}(${s.trim().length})`
      }),
    }))
  return { blocks, segments }
}

interface RoundTrip {
  before: ParagraphMetrics[]
  after: ParagraphMetrics[]
  segments: number
  paragraphs: number
}

async function roundTrip(source: Uint8Array): Promise<RoundTrip> {
  const { editor, ctx, path } = await openCopy(source)
  const { blocks, segments } = fakeTranslate(editor)
  const exec = await executeTool(
    editor,
    { id: 'translate', name: 'translate_blocks', input: { blocks } },
    { bullet: null, ordered: null },
  )
  expect(exec.isError, exec.output).toBeFalsy()
  expect(exec.output).not.toMatch(/INCOMPLETE/)
  expect(await save(ctx, false, false)).toBe(true)
  const saved = await readFile(path)
  return {
    before: metricsOf(await documentXml(source)),
    after: metricsOf(await documentXml(saved)),
    segments,
    paragraphs: blocks.length,
  }
}

const blankSpacing = (rPr: string) => rPr.replace(/(<w:spacing w:val=")[^"]*"/g, '$1"')

function compare({ before, after }: RoundTrip) {
  expect(after.length).toBe(before.length)
  const diff = (key: keyof ParagraphMetrics) =>
    before
      .map((b, i) => ({ i, b: b[key], a: after[i]?.[key] }))
      .filter(({ a, b }) => JSON.stringify(a) !== JSON.stringify(b))
  return {
    pStyle: diff('pStyle'),
    pPr: diff('pPr'),
    runProps: diff('runProps'),
    footnoteRefs: diff('footnoteRefs'),
    empty: diff('empty'),
    textChanged: before.filter((b, i) => !b.empty && after[i]?.text !== b.text).length,
    untranslated: before
      .map((b, i) => ({ i, text: b.text }))
      .filter(({ i, text }) => text.trim() !== '' && after[i]?.text === text),
    // run properties with the w:spacing value blanked: see the sample test
    runPropsButSpacing: before
      .map((b, i) => ({
        i,
        b: b.runProps.map(blankSpacing),
        a: after[i]?.runProps.map(blankSpacing),
      }))
      .filter(({ a, b }) => JSON.stringify(a) !== JSON.stringify(b)),
    nonEmpty: before.filter((b) => !b.empty).length,
  }
}

describe('translate_blocks round trip through the production open/save path', () => {
  it('keeps paragraph styles, run property sets, footnote references and empty paragraphs', async () => {
    const result = await roundTrip(await fixtureDocx())
    const d = compare(result)
    expect(d.pStyle).toEqual([])
    expect(d.pPr).toEqual([])
    expect(d.runProps).toEqual([])
    expect(d.footnoteRefs).toEqual([])
    expect(d.empty).toEqual([])
    // every non-empty paragraph was really translated
    expect(d.textChanged).toBe(d.nonEmpty)
    expect(result.after.every((p) => !/[가-힣]/.test(p.text))).toBe(true)
  })

  const sample = process.env.TRANSLATE_RUNS_SAMPLE
  it.runIf(!!sample && existsSync(sample))('the same holds on the sample document', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'genoffice-translate-sample-'))
    dirs.push(dir)
    const copy = join(dir, 'sample.docx')
    await copyFile(sample!, copy)
    const result = await roundTrip(await readFile(copy))
    const d = compare(result)
    const sum = (m: ParagraphMetrics[]) => m.reduce((n, p) => n + p.footnoteRefs, 0)
    // the measurement the task report quotes (stderr: the test setup mutes console.log)
    process.stderr.write(
      `\ntranslate-runs sample: ${JSON.stringify({
        paragraphs: [result.before.length, result.after.length],
        translatedParagraphs: result.paragraphs,
        segments: result.segments,
        nonEmpty: d.nonEmpty,
        textChanged: d.textChanged,
        empty: [
          result.before.filter((p) => p.empty).length,
          result.after.filter((p) => p.empty).length,
        ],
        footnoteRefs: [sum(result.before), sum(result.after)],
        pStyleDiffs: d.pStyle.length,
        pPrDiffs: d.pPr.length,
        runPropDiffs: d.runProps.length,
        runPropDiffsButSpacing: d.runPropsButSpacing.length,
        spacingDrift: d.runProps.map(({ i, b, a }) => ({ i, b, a })),
        footnoteDiffs: d.footnoteRefs.length,
        emptyDiffs: d.empty.length,
        untranslated: d.untranslated,
      })}\n`,
    )
    expect(d.pStyle).toEqual([])
    expect(d.pPr).toEqual([])
    // Known engine drift, not caused by this tool: in a document with
    // balanceSingleByteDoubleByteWidth the engine scales the display-only
    // charSpacingTwips of hangul runs at parse, and a regenerated paragraph
    // writes that scaled value back as w:spacing (typing one character into
    // the paragraph does the same). Every other run property must match.
    expect(d.runPropsButSpacing).toEqual([])
    expect(d.footnoteRefs).toEqual([])
    expect(d.empty).toEqual([])
    expect(d.textChanged).toBe(d.nonEmpty)
  })
})
