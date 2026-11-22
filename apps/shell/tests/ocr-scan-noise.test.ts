import { expect, it } from 'vitest'
import { hasIsolatedScanNoise, isolatedTone } from '../src/main/ocr-scan-noise'

it('removes isolated specks only on broadly noisy paper and protects adjacent stroke pixels', () => {
  const width = 240
  const px = { width, height: width, rgba: new Uint8Array(width * width * 4).fill(255) }
  const dot = (x: number, y: number) =>
    px.rgba.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3)
  dot(30, 30)
  expect(hasIsolatedScanNoise(px)).toBe(false)
  for (let y = 6; y < width; y += 9) for (let x = 6; x < width; x += 9) dot(x, y)
  expect(hasIsolatedScanNoise(px)).toBe(true)
  expect(isolatedTone(px, 15, 15, 0)).toBe(255)
  dot(16, 15)
  expect(isolatedTone(px, 15, 15, 0)).toBe(0)
})
