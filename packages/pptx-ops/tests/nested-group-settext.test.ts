import { expect, it } from 'vitest'
import {
  appendRawElements,
  createBlankPptx,
  getSlideAnimations,
  openPptx,
  patchSlideXml,
  redactExtXml,
  savePptx,
  setSlideAnimations,
  type OpenedPptx,
} from '@genoffice/pptx-engine'
import { runTxn } from '../src/ops/executor'
import '../src/ops/index'

function shape(id: number, text: string) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm rot="12000"><a:off x="100" y="50"/><a:ext cx="10000" cy="10000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" b="1"/><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`
}

function group(id: number, children: string) {
  return `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="Group ${id}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm rot="1800000" flipH="1"><a:off x="8000" y="12000"/><a:ext cx="30000" cy="40000"/><a:chOff x="400" y="500"/><a:chExt cx="20000" cy="30000"/></a:xfrm></p:grpSpPr>${children}</p:grpSp>`
}

async function nestedDeck(
  editGroupXml: (xml: string) => string = (xml) => xml,
): Promise<OpenedPptx> {
  const opened = await openPptx(await createBlankPptx())
  expect(
    appendRawElements(opened, 0, [
      shape(50, 'Below'),
      editGroupXml(
        group(
          51,
          group(
            52,
            group(53, shape(54, 'First phrase') + shape(55, 'Second phrase')) +
              shape(56, 'Sibling'),
          ),
        ),
      ),
      shape(57, 'Above'),
    ]),
  ).not.toBeNull()
  const slide = opened.deck.slides[0]!
  setSlideAnimations(slide, [
    { spid: 51, effect: 'fade', trigger: 'onClick', durationMs: 500, delayMs: 0 },
    { spid: 54, effect: 'appear', trigger: 'afterPrevious', durationMs: 0, delayMs: 0 },
  ])
  return openPptx(await savePptx(opened))
}

const edit = (el: string, text: string) => ({
  op: 'setText',
  target: { slide: 's_1', el },
  group: 'e_51',
  paragraphs: [{ runs: [{ text }] }],
})

it('writes several deeply grouped translations without changing surrounding slide bytes or animation targets', async () => {
  const opened = await nestedDeck()
  const before = patchSlideXml(opened.deck.slides[0]!)
  const animations = getSlideAnimations(opened.deck.slides[0]!)
  expect(animations.map(({ spid }) => spid)).toEqual([51, 54])
  const result = runTxn(opened, {
    ops: [edit('e_54', 'Translated first'), edit('e_55', 'Translated second')],
  })
  expect(result.failures ?? []).toEqual([])
  expect(result.applied).toBe(true)
  const reopened = await openPptx(await savePptx(opened))
  const slide = reopened.deck.slides[0]!
  expect(patchSlideXml(slide)).toBe(
    before
      .replace('First phrase', 'Translated first')
      .replace('Second phrase', 'Translated second'),
  )
  expect(getSlideAnimations(slide)).toEqual(animations)
})

it('rejects a nested batch with an unresolved target without applying its first edit', async () => {
  const opened = await nestedDeck()
  const before = patchSlideXml(opened.deck.slides[0]!)
  const result = runTxn(opened, { ops: [edit('e_54', 'Would change'), edit('e_999', 'Missing')] })
  expect(result.applied).toBe(false)
  expect(patchSlideXml(opened.deck.slides[0]!)).toBe(before)
})

it('keeps the deck unchanged when the target id duplicates another leaf', async () => {
  const opened = await nestedDeck((xml) =>
    xml.replace('<p:cNvPr id="55" name="Shape 55"/>', '<p:cNvPr id="54" name="Shape 55"/>'),
  )
  const before = patchSlideXml(opened.deck.slides[0]!)
  const result = runTxn(opened, { ops: [edit('e_54', 'Would change')] })
  expect(result.applied).toBe(false)
  expect(result.failures?.[0]?.error).toContain('no unique text child')
  expect(patchSlideXml(opened.deck.slides[0]!)).toBe(before)
})

it('refuses nested edits to withheld text even through the legacy shape id', async () => {
  const opened = await nestedDeck((xml) =>
    xml.replace(
      '<a:rPr lang="en-US" b="1"/><a:t>First phrase</a:t>',
      `<a:rPr lang="en-US" b="1"><a:extLst>${redactExtXml('hidden text')}</a:extLst></a:rPr><a:t>First phrase</a:t>`,
    ),
  )
  const before = patchSlideXml(opened.deck.slides[0]!)
  const result = runTxn(opened, { ops: [edit('e_54', 'Would overwrite')] })
  expect(result.applied).toBe(false)
  expect(result.failures?.[0]?.error).toContain('withheld text')
  expect(patchSlideXml(opened.deck.slides[0]!)).toBe(before)
})

it('accepts an existing leaf creation id and keeps the supplied paragraph properties', async () => {
  const creation =
    '<a:extLst><a:ext uri="{FF2B5EF4-FFF2-40B4-BE49-F238E27FC236}"><a16:creationId xmlns:a16="http://schemas.microsoft.com/office/drawing/2014/main" id="{ab1234cd-eeee-4444-aaaa-abcdefabcdef}"/></a:ext></a:extLst>'
  const opened = await nestedDeck((xml) =>
    xml.replace(
      '<p:cNvPr id="54" name="Shape 54"/>',
      `<p:cNvPr id="54" name="Shape 54">${creation}</p:cNvPr>`,
    ),
  )
  const result = runTxn(opened, {
    ops: [
      {
        ...edit('e_ab1234cd', 'Translated'),
        paragraphs: [{ align: 'center', lineSpacingPct: 120, runs: [{ text: 'Translated' }] }],
      },
    ],
  })
  expect(result.failures ?? []).toEqual([])
  expect(result.applied).toBe(true)
  const reopened = await openPptx(await savePptx(opened))
  const xml = patchSlideXml(reopened.deck.slides[0]!)
  expect(xml).toContain(creation)
  expect(xml).toMatch(/<a:spcPct val="120000"\/>[\s\S]*?<a:t>Translated<\/a:t>/)
})

it('clears only the selected nested text body', async () => {
  const opened = await nestedDeck()
  const result = runTxn(opened, { ops: [{ ...edit('e_54', ''), paragraphs: [] }] })
  expect(result.applied).toBe(true)
  const reopened = await openPptx(await savePptx(opened))
  const xml = patchSlideXml(reopened.deck.slides[0]!)
  expect(xml).not.toContain('First phrase')
  expect(xml).toContain('Second phrase')
  expect(getSlideAnimations(reopened.deck.slides[0]!).map(({ spid }) => spid)).toEqual([51, 54])
})
