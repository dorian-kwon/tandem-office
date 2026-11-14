import type { OcrBox } from '../../../shared/ocr-boxes'

/** the smallest width or height a box keeps, as a ratio of the picture */
export const MIN_BOX_SIZE = 0.02

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value))

/** the box moved by a delta (ratios of the picture), kept inside the picture */
export function moveBox(box: OcrBox, dx: number, dy: number): OcrBox {
  return {
    ...box,
    x: clamp(box.x + dx, 0, 1 - box.w),
    y: clamp(box.y + dy, 0, 1 - box.h),
  }
}

/** the box resized from its bottom-right corner, never below the minimum or outside the picture */
export function resizeBox(box: OcrBox, dw: number, dh: number): OcrBox {
  return {
    ...box,
    w: clamp(box.w + dw, MIN_BOX_SIZE, 1 - box.x),
    h: clamp(box.h + dh, MIN_BOX_SIZE, 1 - box.y),
  }
}

/** an empty box a person adds, inside the picture */
export function newBox(): OcrBox {
  return { x: 0.1, y: 0.1, w: 0.3, h: 0.1, fontHeight: 0.05, text: '' }
}
