import { describe, expect, it } from 'vitest'
import { decodeBmpForJpeg } from '../src/main/document-images/bmp'

function bmp(width = 2, height = 2, bits = 24): Buffer {
  const stride = Math.ceil((width * bits) / 32) * 4
  const bytes = Buffer.alloc(54 + stride * Math.abs(height))
  bytes.write('BM')
  bytes.writeUInt32LE(bytes.length, 2)
  bytes.writeUInt32LE(54, 10)
  bytes.writeUInt32LE(40, 14)
  bytes.writeInt32LE(width, 18)
  bytes.writeInt32LE(height, 22)
  bytes.writeUInt16LE(1, 26)
  bytes.writeUInt16LE(bits, 28)
  return bytes
}

describe('BMP decoding for optional JPEG copies', () => {
  it('keeps colors and top-to-bottom ordering while removing row padding', () => {
    const input = bmp()
    // Bottom row: blue, white. Top row: red, green. BMP stores BGR.
    input.set([255, 0, 0, 255, 255, 255], 54)
    input.set([0, 0, 255, 0, 255, 0], 62)
    const result = decodeBmpForJpeg(input)!
    expect([result.width, result.height]).toEqual([2, 2])
    expect([...result.bgra]).toEqual([
      0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 255, 255, 255, 255,
    ])
  })

  it('preserves top-down BMP orientation', () => {
    const input = bmp(1, -2)
    input.set([0, 0, 255], 54)
    input.set([255, 0, 0], 58)
    expect([...decodeBmpForJpeg(input)!.bgra]).toEqual([0, 0, 255, 255, 255, 0, 0, 255])
  })

  it('accepts opaque 32-bit pixels but leaves ambiguous or transparent alpha unchanged', () => {
    const input = bmp(1, 1, 32)
    input.set([12, 34, 56, 255], 54)
    expect([...decodeBmpForJpeg(input)!.bgra]).toEqual([12, 34, 56, 255])
    for (const alpha of [0, 127, 254]) {
      input[57] = alpha
      expect(decodeBmpForJpeg(input)).toBeNull()
    }
  })

  it.each(['truncated', 'signature', 'planes', 'compression', 'palette', 'offset', 'dimensions'])(
    'leaves %s BMPs untouched',
    (reason) => {
      let input = bmp()
      if (reason === 'truncated') input = input.subarray(0, 60)
      if (reason === 'signature') input.write('NO')
      if (reason === 'planes') input.writeUInt16LE(2, 26)
      if (reason === 'compression') input.writeUInt32LE(1, 30)
      if (reason === 'palette') input.writeUInt16LE(8, 28)
      if (reason === 'offset') input.writeUInt32LE(20, 10)
      if (reason === 'dimensions') input.writeInt32LE(2_000_000_000, 18)
      expect(decodeBmpForJpeg(input)).toBeNull()
    },
  )

  it('rejects short headers and dimensions exceeding the allocation budget', () => {
    expect(decodeBmpForJpeg(Buffer.alloc(2))).toBeNull()
    const input = bmp()
    input.writeInt32LE(50_000, 18)
    input.writeInt32LE(50_000, 22)
    expect(decodeBmpForJpeg(input)).toBeNull()
  })
})
