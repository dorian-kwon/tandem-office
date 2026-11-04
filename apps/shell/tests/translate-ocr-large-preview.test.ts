import { describe, expect, it } from 'vitest'
import { largePreviewJpeg, type PreviewImage } from '../src/main/translate/ocr-large-preview'

/** A fake image whose JPEG size grows with its pixel count and quality. */
function fake(width: number, height: number, bytesPerPixel: number): PreviewImage {
  const make = (w: number, h: number): PreviewImage => ({
    isEmpty: () => false,
    getSize: () => ({ width: w, height: h }),
    resize: (o) => make(o.width, o.height),
    toJPEG: (q) => new Uint8Array(Math.round((w * h * bytesPerPixel * q) / 100)),
  })
  return make(width, height)
}

describe('largePreviewJpeg', () => {
  it('keeps a tall strip at full width and height when it fits the cap', () => {
    const resized = { called: false }
    const image: PreviewImage = {
      ...fake(439, 2048, 0.2),
      resize: () => {
        resized.called = true
        return fake(1, 1, 1)
      },
      toJPEG: () => new Uint8Array(100_000),
    }
    expect(largePreviewJpeg(image)!.length).toBe(100_000)
    expect(resized.called).toBe(false)
  })

  it('shrinks until the result fits the 2 MB cap', () => {
    const out = largePreviewJpeg(fake(6000, 4000, 1))
    expect(out).not.toBeNull()
    expect(out!.length).toBeLessThanOrEqual(2 * 1024 * 1024)
  })

  it('gives up with null when nothing fits, and for an empty image', () => {
    expect(largePreviewJpeg(fake(6000, 4000, 1), 10)).toBeNull()
    expect(largePreviewJpeg({ ...fake(1, 1, 1), isEmpty: () => true })).toBeNull()
  })
})
