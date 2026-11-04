import { OCR_LARGE_PREVIEW_MAX_BYTES } from './ocr'

/** The part of Electron's nativeImage the preview needs (a fake in tests). */
export interface PreviewImage {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(options: {
    width: number
    height: number
    quality?: 'good' | 'better' | 'best'
  }): PreviewImage
  toJPEG(quality: number): Uint8Array
}

/** longest edge of the first attempt; a tall strip keeps its full height up to this */
const FIRST_EDGE = 2600
const QUALITIES = [85, 70, 55]

/**
 * Downscale one picture for the enlarged local preview: a JPEG that fits the byte cap, shrinking
 * the longest edge step by step (and lowering quality) until it does. Null when it cannot.
 */
export function largePreviewJpeg(
  image: PreviewImage,
  cap: number = OCR_LARGE_PREVIEW_MAX_BYTES,
): Uint8Array | null {
  if (image.isEmpty()) return null
  const size = image.getSize()
  if (size.width < 1 || size.height < 1) return null
  let edge = FIRST_EDGE
  for (let attempt = 0; attempt < 6; attempt++) {
    const scale = Math.min(edge / Math.max(size.width, size.height), 1)
    const sized =
      scale < 1
        ? image.resize({
            width: Math.max(1, Math.round(size.width * scale)),
            height: Math.max(1, Math.round(size.height * scale)),
            quality: 'best',
          })
        : image
    for (const quality of QUALITIES) {
      const data = sized.toJPEG(quality)
      if (data.length > 0 && data.length <= cap) return data
    }
    edge = Math.round(edge * 0.75)
  }
  return null
}
