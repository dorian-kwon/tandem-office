import type { RasterPixels } from '../../../../packages/pdf2docx/src/ocr-raster'

// Replace only a single outlier on a locally flat background. A two-pixel
// punctuation mark or a thin stroke has at least one similar neighbour.
export function isolatedTone(px: RasterPixels, x: number, y: number, value: number): number {
  if (x < 2 || y < 2 || x + 2 >= px.width || y + 2 >= px.height) return value
  const i = (y * px.width + x) * 4
  const background = px.rgba[i - 4 + 1]!
  if (Math.abs(value - background) < 96) return value
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (dx === 0 && dy === 0) continue
      const offset = i + 4 * (dy * px.width + dx)
      if (Math.abs(px.rgba[offset + 1]! - background) > 20) return value
    }
  }
  return background
}

// Sample small patches across the scan. An isolated full stop or a halftone
// photograph in a corner should not switch the entire scan to denoising.
export function hasIsolatedScanNoise(px: RasterPixels): boolean {
  if (px.width < 96 || px.height < 96) return false
  let affected = 0
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const top = Math.floor(((row + 0.5) * px.height) / 4) - 10
      const left = Math.floor(((col + 0.5) * px.width) / 4) - 10
      let hits = 0
      for (let y = top; y < top + 20 && hits < 2; y++)
        for (let x = left; x < left + 20 && hits < 2; x++) {
          const tone = px.rgba[(y * px.width + x) * 4 + 1]!
          if (isolatedTone(px, x, y, tone) !== tone) hits++
        }
      if (hits >= 2 && ++affected >= 4) return true
    }
  }
  return false
}
