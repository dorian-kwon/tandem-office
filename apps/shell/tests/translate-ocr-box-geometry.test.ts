import { describe, expect, it } from 'vitest'
import {
  MIN_BOX_SIZE,
  moveBox,
  newBox,
  resizeBox,
} from '../src/renderer/src/translate/ocr-box-geometry'
import type { OcrBox } from '../src/shared/ocr-boxes'

const box = (over: Partial<OcrBox> = {}): OcrBox => ({
  x: 0.4,
  y: 0.4,
  w: 0.2,
  h: 0.1,
  fontHeight: 0.05,
  text: 'Name',
  ...over,
})
const inside = (b: OcrBox) =>
  b.x >= 0 &&
  b.y >= 0 &&
  b.w >= MIN_BOX_SIZE &&
  b.h >= MIN_BOX_SIZE &&
  b.x + b.w <= 1 + 1e-9 &&
  b.y + b.h <= 1 + 1e-9

describe('ocr box geometry', () => {
  it('moveBox moves by the delta and keeps the box inside the picture', () => {
    const moved = moveBox(box(), 0.1, -0.1)
    expect(moved.x).toBeCloseTo(0.5)
    expect(moved.y).toBeCloseTo(0.3)
    expect(moved).toMatchObject({ w: 0.2, h: 0.1 })
    const corner = moveBox(box(), 5, 5)
    expect(corner.x).toBeCloseTo(0.8)
    expect(corner.y).toBeCloseTo(0.9)
    const origin = moveBox(box(), -5, -5)
    expect(origin).toMatchObject({ x: 0, y: 0 })
    expect(inside(corner) && inside(origin)).toBe(true)
  })

  it('moveBox keeps the text and the text height', () => {
    expect(moveBox(box(), 0.1, 0.1)).toMatchObject({ text: 'Name', fontHeight: 0.05 })
  })

  it('resizeBox never goes below the minimum size or outside the picture', () => {
    expect(resizeBox(box(), -5, -5)).toMatchObject({ w: MIN_BOX_SIZE, h: MIN_BOX_SIZE })
    const grown = resizeBox(box(), 5, 5)
    expect(grown.x + grown.w).toBeCloseTo(1)
    expect(grown.y + grown.h).toBeCloseTo(1)
    expect(inside(grown)).toBe(true)
    const resized = resizeBox(box(), 0.1, 0.05)
    expect(resized).toMatchObject({ x: 0.4, y: 0.4 })
    expect(resized.w).toBeCloseTo(0.3)
    expect(resized.h).toBeCloseTo(0.15)
  })

  it('newBox is inside the picture and empty', () => {
    const created = newBox()
    expect(inside(created)).toBe(true)
    expect(created.text).toBe('')
    expect(created.fontHeight).toBeGreaterThan(0)
  })
})
