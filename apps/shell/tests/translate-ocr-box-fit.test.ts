import { describe, expect, it } from 'vitest'
import {
  boxFontHalfPoints,
  estimateTextEm,
  fitBoxFontHalfPoints,
  type OcrBox,
} from '../src/shared/ocr-boxes'
import { buildImageBoxParagraphsXml } from '../src/main/translate/ocr-boxes-docx'

/**
 * The text of a box is set at the largest size at which it still fits the box. The size the
 * lettering had gives the most it may be; a longer text, or a font wider than the lettering,
 * would run past the box and be cut off, so it is made smaller until it fits.
 */

const PICTURE = { width: 300, height: 300 } // points
const box = (over: Partial<OcrBox> = {}): OcrBox => ({
  x: 0.1,
  y: 0.1,
  w: 0.2,
  h: 0.08,
  fontHeight: 0.08,
  text: 'Menu',
  ...over,
})
const fit = (b: OcrBox) => fitBoxFontHalfPoints(b, PICTURE.width, PICTURE.height)
/** whether the text at this size fits the box in the estimate the fit itself uses */
const lines = (b: OcrBox, half: number) => {
  const size = half / 2
  const widthPt = b.w * PICTURE.width
  return b.text
    .split(/\r?\n/)
    .reduce(
      (n, line) => n + Math.max(1, Math.ceil((estimateTextEm(line) * size * 1.12) / widthPt)),
      0,
    )
}

describe('how wide a text is, without reading a font', () => {
  it('counts a Korean or Chinese letter as one em and a Latin letter as about half', () => {
    expect(estimateTextEm('해물파전')).toBeCloseTo(4, 5)
    expect(estimateTextEm('漢字')).toBeCloseTo(2, 5)
    expect(estimateTextEm('abcd')).toBeGreaterThan(1.8)
    expect(estimateTextEm('abcd')).toBeLessThan(2.6)
  })

  it('counts a capital wider than a small letter and a space narrower than both', () => {
    expect(estimateTextEm('M')).toBeGreaterThan(estimateTextEm('m'))
    expect(estimateTextEm(' ')).toBeLessThan(estimateTextEm('m'))
  })

  it('counts nothing for no text', () => {
    expect(estimateTextEm('')).toBe(0)
  })
})

describe('the size of the text of a box', () => {
  it('keeps the size of the lettering when the text has room', () => {
    const b = box({ w: 0.6, text: 'Menu' })
    expect(fit(b)).toBe(boxFontHalfPoints(b, PICTURE.height))
  })

  it('makes a long text smaller so that it stays inside a box that is one line high', () => {
    const b = box({ w: 0.2, h: 0.08, text: '해물파전 소갈비찜' })
    const wanted = boxFontHalfPoints(b, PICTURE.height)
    const got = fit(b)
    expect(got).toBeLessThan(wanted)
    // the lines it takes, at the size it got, are inside the height of the box
    expect(lines(b, got) * (got / 2) * 1.2).toBeLessThanOrEqual(b.h * PICTURE.height + 0.01)
  })

  it('does not go smaller than it must: a half-point more would no longer fit', () => {
    const b = box({ w: 0.2, h: 0.08, text: '해물파전 소갈비찜' })
    const got = fit(b)
    expect(lines(b, got + 1) * ((got + 1) / 2) * 1.2).toBeGreaterThan(b.h * PICTURE.height)
  })

  it('lets a text take as many lines as the height of the box holds', () => {
    const tall = box({ w: 0.2, h: 0.3, text: '해물파전 소갈비찜 매운 갈비 쭈꾸미 볶음' })
    const flat = { ...tall, h: 0.08 }
    expect(fit(tall)).toBeGreaterThan(fit(flat))
    const got = fit(tall)
    expect(lines(tall, got) * (got / 2) * 1.2).toBeLessThanOrEqual(tall.h * PICTURE.height + 0.01)
  })

  it('fits every line of a text of several lines', () => {
    const b = box({ w: 0.25, h: 0.2, text: '메인메뉴\n파 육개장 한방 왕 갈비탕\n10,000' })
    const got = fit(b)
    expect(lines(b, got) * (got / 2) * 1.2).toBeLessThanOrEqual(b.h * PICTURE.height + 0.01)
  })

  it('never makes it larger than the lettering was, nor smaller than 6 points', () => {
    expect(fit(box({ w: 0.9, h: 0.5, fontHeight: 0.02, text: 'a' }))).toBe(
      boxFontHalfPoints(box({ fontHeight: 0.02 }), PICTURE.height),
    )
    const crowded = box({ w: 0.02, h: 0.01, text: '아주아주아주아주 긴 글' })
    expect(fit(crowded)).toBe(12)
  })

  it('sizes a box with no text like any other and does not fail', () => {
    expect(fit(box({ text: '' }))).toBe(boxFontHalfPoints(box(), PICTURE.height))
  })
})

describe('the boxes written over a picture use the fitted size', () => {
  const info = { ok: true as const, widthEmu: 300 * 12700, heightEmu: 300 * 12700, afterTwips: 0 }

  it('writes the smaller size for a long text and the lettering size for a short one', () => {
    const long = box({ text: '해물파전 소갈비찜', w: 0.2, h: 0.08 })
    const short = box({ text: 'OK', w: 0.5, h: 0.08, y: 0.5 })
    const xml = buildImageBoxParagraphsXml([long, short], info, 1)
    const sizes = [...xml.matchAll(/<w:sz w:val="(\d+)"/g)].map((m) => Number(m[1]))
    expect(sizes).toContain(fit(long))
    expect(sizes).toContain(boxFontHalfPoints(short, PICTURE.height))
    expect(fit(long)).toBeLessThan(boxFontHalfPoints(long, PICTURE.height))
  })
})
