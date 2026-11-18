/** Bounded BMP decoding for explicitly requested JPEG document copies. */
export const MAX_BMP_BYTES = 192 * 1024 * 1024
export const MAX_BMP_PIXELS = 80_000_000

export interface DecodedBmp {
  width: number
  height: number
  bgra: Buffer
}

/** Unsupported, color-profiled or ambiguous alpha images stay in their original format. */
export function decodeBmpForJpeg(input: Uint8Array): DecodedBmp | null {
  if (input.byteLength < 54 || input.byteLength > MAX_BMP_BYTES) return null
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  if (bytes.toString('ascii', 0, 2) !== 'BM') return null
  const header = bytes.readUInt32LE(14)
  if (![40, 108, 124].includes(header) || bytes.length < 14 + header) return null
  const width = bytes.readInt32LE(18)
  const signedHeight = bytes.readInt32LE(22)
  const height = Math.abs(signedHeight)
  const bits = bytes.readUInt16LE(28)
  const offset = bytes.readUInt32LE(10)
  if (
    width <= 0 ||
    height <= 0 ||
    width * height > MAX_BMP_PIXELS ||
    bytes.readUInt16LE(26) !== 1 ||
    ![24, 32].includes(bits) ||
    bytes.readUInt32LE(30) !== 0 ||
    offset < 14 + header
  )
    return null
  // V4/V5 color masks and profiles need a color-managed decoder. Do not silently
  // drop their alpha or reinterpret calibrated colors as sRGB.
  if (header >= 108) {
    if (
      bytes.readUInt32LE(54) ||
      bytes.readUInt32LE(58) ||
      bytes.readUInt32LE(62) ||
      bytes.readUInt32LE(66)
    )
      return null
    if (bytes.readUInt32LE(70) !== 0x73524742) return null
    if (header === 124 && (bytes.readUInt32LE(126) !== 0 || bytes.readUInt32LE(130) !== 0))
      return null
  }
  const stride = Math.ceil((width * bits) / 32) * 4
  if (offset + stride * height > bytes.length) return null
  // Some writers use the otherwise unused high byte as alpha. Preserve those
  // files rather than flattening an ambiguous/transparent image into JPEG.
  if (bits === 32) {
    for (let row = 0; row < height; row++) {
      const start = offset + row * stride
      for (let x = 0; x < width; x++) if (bytes[start + x * 4 + 3] !== 255) return null
    }
  }
  const bgra = Buffer.allocUnsafe(width * height * 4)
  const step = bits / 8
  for (let y = 0; y < height; y++) {
    const from = offset + (signedHeight > 0 ? height - 1 - y : y) * stride
    const to = y * width * 4
    for (let x = 0; x < width; x++) {
      const src = from + x * step
      const dst = to + x * 4
      bgra[dst] = bytes[src]!
      bgra[dst + 1] = bytes[src + 1]!
      bgra[dst + 2] = bytes[src + 2]!
      bgra[dst + 3] = 255
    }
  }
  return { width, height, bgra }
}
