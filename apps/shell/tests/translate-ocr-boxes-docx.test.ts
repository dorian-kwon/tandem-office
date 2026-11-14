import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { parseDocx } from '@genoffice/docx-engine'
import { buildDocx, TINY_PNG_BASE64 } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { inspectBoxableImage } from '../src/main/translate/ocr-boxes-docx'
import { placeOcrText, type OcrTextItem } from '../src/main/translate/ocr-placement'
import { boxFontHalfPoints, OCR_MAX_BOXES, type OcrBox } from '../src/shared/ocr-boxes'

/**
 * Boxes over a docx picture (docs/plans/ocr-box-placement.md): which pictures can take them, and
 * the anchored white text boxes written for the rest of the pipeline to read and translate.
 */

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const W = 3000000
const H = 1500000

function drawing(
  o: { rel?: string; kind?: 'inline' | 'anchor'; xfrm?: string; srcRect?: string } = {},
) {
  const kind = o.kind ?? 'inline'
  return (
    `<w:r><w:drawing><wp:${kind}><wp:extent cx="${W}" cy="${H}"/>` +
    `<wp:docPr id="7" name="Picture 7"/><a:graphic><a:graphicData ` +
    `uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill>` +
    `<a:blip r:embed="${o.rel ?? 'rId10'}"/>${o.srcRect ?? ''}</pic:blipFill><pic:spPr>` +
    `<a:xfrm${o.xfrm ?? ''}><a:off x="0" y="0"/><a:ext cx="${W}" cy="${H}"/></a:xfrm>` +
    `</pic:spPr></pic:pic></a:graphicData></a:graphic></wp:${kind}></w:drawing></w:r>`
  )
}
const para = (inner: string, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${inner}</w:p>`
const text = (t: string) => `<w:r><w:t>${t}</w:t></w:r>`
const documentOf = (body: string) => `<w:document ${NS}><w:body>${body}</w:body></w:document>`
const inspect = (body: string, n = 2, rel = 'rId10', part = 'word/document.xml') =>
  inspectBoxableImage(part, documentOf(body), n, rel)

describe('inspectBoxableImage', () => {
  it('accepts a left-aligned paragraph with one inline picture and returns its extent', () => {
    expect(inspect(para(text('Intro')) + para(drawing()))).toEqual({
      ok: true,
      widthEmu: W,
      heightEmu: H,
      afterTwips: 0,
    })
  })

  it('reads the spacing after the picture paragraph', () => {
    const info = inspect(para(text('Intro')) + para(drawing(), '<w:spacing w:after="160"/>'))
    expect(info).toMatchObject({ ok: true, afterTwips: 160 })
  })

  it.each([
    ['anchored', para(text('x')) + para(drawing({ kind: 'anchor' }))],
    ['cropped', para(text('x')) + para(drawing({ srcRect: '<a:srcRect l="1000"/>' }))],
    ['rotated', para(text('x')) + para(drawing({ xfrm: ' rot="5400000"' }))],
    ['rotated', para(text('x')) + para(drawing({ xfrm: ' flipH="1"' }))],
    ['container', para(text('x')) + `<w:tbl><w:tr><w:tc>${para(drawing())}</w:tc></w:tr></w:tbl>`],
    ['crowded', para(text('x')) + para(text('caption') + drawing())],
    ['crowded', para(text('x')) + para(drawing() + drawing())],
    ['aligned', para(text('x')) + para(drawing(), '<w:jc w:val="center"/>')],
    ['aligned', para(text('x')) + para(drawing(), '<w:ind w:left="720"/>')],
    ['aligned', para(text('x')) + para(drawing(), '<w:spacing w:line="240" w:lineRule="exact"/>')],
  ])('refuses a picture that is %s', (reason, body) => {
    expect(inspect(body)).toEqual({ ok: false, reason })
  })

  it('refuses a picture in a header and a relationship the paragraph does not hold', () => {
    const body = para(text('x')) + para(drawing())
    expect(inspect(body, 2, 'rId10', 'word/header1.xml')).toEqual({
      ok: false,
      reason: 'container',
    })
    expect(inspect(body, 2, 'rId99')).toEqual({ ok: false, reason: 'missing' })
  })
})

const box = (over: Partial<OcrBox> = {}): OcrBox => ({
  x: 0.1,
  y: 0.2,
  w: 0.3,
  h: 0.1,
  fontHeight: 0.08,
  text: 'Name',
  ...over,
})

async function pictureDoc(extraBody = '') {
  return buildDocx({
    withImage: true,
    bodyXml: para(text('Intro')) + para(drawing()) + para(text('After text')) + extraBody,
  })
}
const item = (over: Partial<OcrTextItem> = {}): OcrTextItem => ({
  index: 1,
  text: 'Name',
  location: 'document.xml · ¶2',
  part: 'word/document.xml',
  relId: 'rId10',
  ...over,
})
const place = (
  bytes: Uint8Array,
  items: OcrTextItem[],
  images: { index: number; boxes: OcrBox[] }[],
) => placeOcrText(bytes, 'docx', items, { kind: 'docx-image-boxes', images })
const documentXml = async (bytes: Uint8Array) =>
  (await (await JSZip.loadAsync(bytes)).file('word/document.xml')!.async('string'))!

describe('placing boxes over a docx picture', () => {
  it('writes one white text box per box and keeps the picture and the media bytes', async () => {
    const source = await pictureDoc()
    const boxes = [box(), box({ text: 'Date', y: 0.6, x: 0.5 })]
    const result = await place(source, [item({ text: 'Name\nDate' })], [{ index: 1, boxes }])
    const xml = await documentXml(result)

    // a text box is written twice in a text box shape: the wps content and its VML fallback
    expect(xml.match(/<w:txbxContent>/g)).toHaveLength(boxes.length * 2)
    expect(xml).toContain('Name')
    expect(xml).toContain('Date')
    expect(xml).toContain('<a:srgbClr val="FFFFFF"/>')
    const half = boxFontHalfPoints(boxes[0]!, H / 12700)
    expect(xml).toContain(`<w:sz w:val="${half}"/>`)
    expect(xml).toContain('r:embed="rId10"')
    const zip = await JSZip.loadAsync(result)
    expect(await zip.file('word/media/image1.png')!.async('base64')).toBe(TINY_PNG_BASE64)
  })

  it('offsets each box by the formula and puts the boxes right after the picture paragraph', async () => {
    const boxes = [box(), box({ text: 'Date', y: 0.6, x: 0.5 })]
    const xml = await documentXml(
      await place(await pictureDoc(), [item({ text: 'Name\nDate' })], [{ index: 1, boxes }]),
    )
    const verticals = [
      ...xml.matchAll(
        /<wp:positionV relativeFrom="paragraph"><wp:posOffset>(-?\d+)<\/wp:posOffset>/g,
      ),
    ].map((m) => Number(m[1]))
    expect(verticals).toEqual(boxes.map((b, k) => Math.round(b.y * H - H - k * 20 * 635)))
    const horizontals = [
      ...xml.matchAll(/<wp:positionH relativeFrom="column"><wp:posOffset>(\d+)</g),
    ].map((m) => Number(m[1]))
    expect(horizontals).toEqual(boxes.map((b) => Math.round(b.x * W)))
    expect(xml.indexOf('r:embed="rId10"')).toBeLessThan(xml.indexOf('<mc:AlternateContent'))
    expect(xml.indexOf('<mc:AlternateContent')).toBeLessThan(xml.indexOf('After text'))
  })

  it('escapes markup and control characters in box text', async () => {
    const xml = await documentXml(
      await place(
        await pictureDoc(),
        [item()],
        [{ index: 1, boxes: [box({ text: 'A & B <x> \u0001ok' })] }],
      ),
    )
    expect(xml).toContain('A &amp; B &lt;x&gt; ok')
    expect(xml).not.toContain('\u0001')
  })

  it('is read back by the document parser as anchored text boxes with the box text', async () => {
    const result = await place(
      await pictureDoc(),
      [item({ text: 'Name\nDate' })],
      [{ index: 1, boxes: [box(), box({ text: 'Date', y: 0.6 })] }],
    )
    const parsed = await parseDocx(result)
    const texts = parsed.blocks
      .flatMap((b) => b.textboxes ?? [])
      .flatMap((t) => t.paras.map((p) => p.runs.map((r) => r.text).join('')))
    expect(texts).toEqual(['Name', 'Date'])
  })

  it('puts a paragraph after a picture that cannot take boxes, in the same pass', async () => {
    const source = await buildDocx({
      withImage: true,
      bodyXml:
        para(text('Intro')) +
        para(drawing()) +
        para(text('Middle')) +
        para(drawing({ kind: 'anchor' })) +
        para(text('Last')),
    })
    const result = await place(
      source,
      [
        item({ text: 'Name' }),
        item({
          index: 2,
          text: 'Fallback words',
          location: 'document.xml · ¶4',
        }),
      ],
      [{ index: 1, boxes: [box()] }],
    )
    const xml = await documentXml(result)
    expect(xml.match(/<w:txbxContent>/g)).toHaveLength(2)
    const fallback = xml.indexOf('Fallback words')
    expect(fallback).toBeGreaterThan(xml.indexOf('Middle'))
    expect(fallback).toBeLessThan(xml.indexOf('Last'))
  })

  it('falls back to a paragraph for a picture with no boxes in the placement', async () => {
    const xml = await documentXml(
      await place(await pictureDoc(), [item({ text: 'Plain words' })], []),
    )
    expect(xml).not.toContain('<w:txbxContent>')
    expect(xml).toContain('Plain words')
  })

  it('rejects boxes outside 0..1, too many boxes and indexes that were not read', async () => {
    const source = await pictureDoc()
    const bad = (images: { index: number; boxes: OcrBox[] }[]) => place(source, [item()], images)
    await expect(bad([{ index: 1, boxes: [box({ x: 0.9, w: 0.3 })] }])).rejects.toThrow(
      /INVALID_ARGUMENT|box/i,
    )
    await expect(bad([{ index: 1, boxes: [box({ w: 0 })] }])).rejects.toThrow()
    await expect(
      bad([{ index: 1, boxes: Array.from({ length: OCR_MAX_BOXES + 1 }, () => box()) }]),
    ).rejects.toThrow()
    await expect(bad([{ index: 5, boxes: [box()] }])).rejects.toThrow()
  })
})
