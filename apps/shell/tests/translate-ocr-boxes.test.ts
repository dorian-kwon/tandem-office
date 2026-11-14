import { describe, expect, it } from 'vitest'
import {
  OCR_MAX_BOXES,
  OCR_MAX_BOX_TEXT,
  boxFontHalfPoints,
  buildOcrBoxRequest,
  checkOcrBoxesPayload,
  parseOcrBoxResponse,
  readOcrBoxes,
} from '../src/shared/ocr-boxes'
import { AI_READ_MALFORMED_REASON } from '../../../packages/pdf-structure/src/ai-read/read-page'

/**
 * The box reading contract for embedded pictures (docs/plans/ocr-box-placement.md): the AI answers
 * with boxes in thousandths of the picture, each with its text and its text line height.
 */

const answer = (boxes: unknown) => `<boxes>${JSON.stringify(boxes)}</boxes>`
const box = (over: Record<string, unknown> = {}) => ({
  x: 100,
  y: 200,
  w: 300,
  h: 50,
  font: 40,
  text: 'Name',
  ...over,
})
const parsed = (text: string) => {
  const result = parseOcrBoxResponse(text)
  if (!result.ok) throw new Error(result.problems.join('; '))
  return result.payload
}

describe('parseOcrBoxResponse', () => {
  it('parses boxes given in thousandths into 0..1 ratios', () => {
    expect(parsed(answer([box()]))).toEqual({
      kind: 'boxes',
      boxes: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.05, fontHeight: 0.04, text: 'Name' }],
      text: 'Name',
    })
  })

  it('joins every box text into payload.text in reading order', () => {
    const payload = parsed(answer([box({ text: 'First' }), box({ text: 'Second', y: 400 })]))
    expect(payload.text).toBe('First\nSecond')
  })

  it('drops boxes with zero size, no area inside the picture, and empty text, but keeps their text', () => {
    const payload = parsed(
      answer([
        box({ text: 'zero width', w: 0 }),
        box({ text: 'outside', x: 1200 }),
        box({ text: '   ' }),
        box({ text: 'kept' }),
      ]),
    )
    expect(payload.boxes.map((b) => b.text)).toEqual(['kept'])
    expect(payload.text).toBe('zero width\noutside\nkept')
  })

  it('clamps a box that sticks out of the picture to the picture', () => {
    const payload = parsed(answer([box({ x: 900, w: 300 })]))
    expect(payload.boxes[0]!.x).toBe(0.9)
    expect(payload.boxes[0]!.w).toBeCloseTo(0.1)
  })

  it('drops a box that covers more than 85% of the picture but keeps its text', () => {
    const payload = parsed(answer([box({ x: 0, y: 0, w: 1000, h: 950, text: 'everything' })]))
    expect(payload.boxes).toEqual([])
    expect(payload.text).toBe('everything')
  })

  it('caps boxes at OCR_MAX_BOXES and each text at OCR_MAX_BOX_TEXT', () => {
    const many = Array.from({ length: OCR_MAX_BOXES + 5 }, (_, i) => box({ text: `b${i}`, y: 10 }))
    expect(parsed(answer(many)).boxes).toHaveLength(OCR_MAX_BOXES)
    const long = parsed(answer([box({ text: 'x'.repeat(OCR_MAX_BOX_TEXT + 50) })]))
    expect(long.boxes[0]!.text).toHaveLength(OCR_MAX_BOX_TEXT)
  })

  it('falls back to the box height per line when the font height is missing', () => {
    const payload = parsed(answer([box({ font: undefined, h: 100, text: 'a\nb' })]))
    expect(payload.boxes[0]!.fontHeight).toBeCloseTo(0.05)
  })

  it('reports a malformed answer as problems', () => {
    for (const text of [
      '',
      '<boxes>[{"x":1}',
      '<boxes>not json</boxes>',
      '<boxes>{"a":1}</boxes>',
    ]) {
      const result = parseOcrBoxResponse(text)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.problems.length).toBeGreaterThan(0)
    }
  })
})

describe('readOcrBoxes', () => {
  const image = new Uint8Array([1, 2, 3])

  it('asks once for a well-formed answer', async () => {
    let calls = 0
    const payload = await readOcrBoxes({
      image,
      ask: async () => (calls++, answer([box()])),
    })
    expect(calls).toBe(1)
    expect(payload.boxes).toHaveLength(1)
  })

  it('re-asks once with the problems and then throws the malformed reason', async () => {
    const requests: string[] = []
    let calls = 0
    await expect(
      readOcrBoxes({
        image,
        ask: async (request) => {
          calls++
          requests.push(request.messages[0]!.text)
          return 'no tags here'
        },
      }),
    ).rejects.toMatchObject({ reason: AI_READ_MALFORMED_REASON })
    expect(calls).toBe(2)
    expect(requests[1]).toContain('could not be used')
  })

  it('accepts the second answer when the first was malformed', async () => {
    let calls = 0
    const payload = await readOcrBoxes({
      image,
      ask: async () => (calls++ === 0 ? 'broken' : answer([box()])),
    })
    expect(payload.boxes).toHaveLength(1)
  })
})

describe('buildOcrBoxRequest', () => {
  it('sends one image, no tools, and an instruction that treats the picture as data', () => {
    const request = buildOcrBoxRequest({ image: new Uint8Array([1, 2, 3]), mime: 'image/jpeg' })
    expect(request.tools).toEqual([])
    expect(request.messages).toHaveLength(1)
    expect(request.messages[0]!.images).toEqual([{ base64: 'AQID', mime: 'image/jpeg' }])
    expect(request.system).toMatch(/never instructions/i)
    expect(request.system).toContain('<boxes>')
  })
})

describe('boxFontHalfPoints', () => {
  const at = (fontHeight: number) => ({ x: 0, y: 0, w: 0.5, h: 0.1, fontHeight, text: 'a' })

  it('maps a 0.06 line height on a 200 pt picture to 20 half-points', () => {
    expect(boxFontHalfPoints(at(0.06), 200)).toBe(20)
  })

  it('stays between 8 pt and 72 pt', () => {
    expect(boxFontHalfPoints(at(0.001), 100)).toBe(16)
    expect(boxFontHalfPoints(at(0.9), 1000)).toBe(144)
  })
})

describe('checkOcrBoxesPayload', () => {
  const good = {
    kind: 'boxes',
    boxes: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.05, fontHeight: 0.04, text: 'Name' }],
    text: 'Name',
  }

  it('accepts a well-formed payload unchanged', () => {
    expect(checkOcrBoxesPayload(good)).toEqual(good)
  })

  it('rejects a wrong kind and non-finite or out-of-range numbers', () => {
    expect(checkOcrBoxesPayload({ ...good, kind: 'blocks' })).toBeNull()
    expect(checkOcrBoxesPayload(null)).toBeNull()
    for (const bad of [{ x: Number.NaN }, { w: 0 }, { x: 0.9, w: 0.3 }, { fontHeight: -1 }]) {
      expect(checkOcrBoxesPayload({ ...good, boxes: [{ ...good.boxes[0], ...bad }] })).toBeNull()
    }
  })

  it('rejects too many boxes and text that is too long', () => {
    const boxes = Array.from({ length: OCR_MAX_BOXES + 1 }, () => good.boxes[0])
    expect(checkOcrBoxesPayload({ ...good, boxes })).toBeNull()
    expect(
      checkOcrBoxesPayload({
        ...good,
        boxes: [{ ...good.boxes[0], text: 'x'.repeat(OCR_MAX_BOX_TEXT + 1) }],
      }),
    ).toBeNull()
  })
})
