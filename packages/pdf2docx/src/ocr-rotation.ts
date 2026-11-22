import type { Rect } from './geometry'
import type { OcrLine } from './ocr'
import type { RasterPixels } from './ocr-raster'

/** Clockwise rotation applied to a displayed page to make its text upright. */
export type ScanTurn = 90 | 180 | 270

export function turnBox(box: Rect, turn: ScanTurn): Rect {
  const { x0, y0, x1, y1 } = box
  // OCR coordinates are normalized, with the origin at the lower left.
  if (turn === 90) return { x0: y0, x1: y1, y0: 1 - x1, y1: 1 - x0 }
  if (turn === 180) return { x0: 1 - x1, x1: 1 - x0, y0: 1 - y1, y1: 1 - y0 }
  return { x0: 1 - y1, x1: 1 - y0, y0: x0, y1: x1 }
}

export function turnLines(lines: OcrLine[], turn: ScanTurn): OcrLine[] {
  return lines.map((line) => ({
    ...line,
    box: turnBox(line.box, turn),
    ...(line.chars && { chars: line.chars.map((c) => ({ ...c, box: turnBox(c.box, turn) })) }),
  }))
}

export function turnPixels(input: RasterPixels, turn: ScanTurn): RasterPixels {
  const { width: w, height: h, rgba } = input
  const dst = new Uint8Array(rgba.length)
  const src = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.byteLength / 4),
    out = new Uint32Array(dst.buffer)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const to =
        turn === 90 ? x * h + (h - 1 - y) : turn === 180 ? w * h - 1 - i : (w - 1 - x) * h + y
      out[to] = src[i]!
    }
  }
  return { rgba: dst, width: turn === 180 ? w : h, height: turn === 180 ? h : w }
}
