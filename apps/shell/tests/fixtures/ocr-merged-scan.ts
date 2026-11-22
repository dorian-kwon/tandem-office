import { encodeRgbaPng } from '../../../../packages/pdf2docx/src/extract/png'

/** A scan with horizontal and vertical merges and matching offline OCR responses. */
export function mergedScan() {
  const width = 400,
    height = 300
  const rgba = new Uint8Array(width * height * 4).fill(255)
  function rule(x0: number, y0: number, x1: number, y1: number) {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = ((height - y - 1) * width + x) * 4
        rgba.fill(0, i, i + 3)
      }
    }
  }
  for (const y of [30, 170, 240]) rule(35, y, 365, y + 1)
  rule(195, 100, 365, 101)
  for (const x of [35, 365]) rule(x, 30, x + 1, 240)
  rule(195, 30, 196, 170)
  const lines = [
    ['Tour schedule', 145, 198],
    ['Busan', 60, 112],
    ['Monday', 216, 128],
    ['Tuesday', 216, 61],
  ] as const
  const recognized = lines.map(([text, x, y]) => {
    const x1 = x + text.length * 7
    for (let xx = x + 1; xx < x1 - 1; xx += 4) rule(xx, y + 1, xx + 1, y + 9)
    return {
      text,
      confidence: 0.99,
      box: { x0: x / width, y0: y / height, x1: x1 / width, y1: (y + 12) / height },
    }
  })
  return { png: encodeRgbaPng(rgba, width, height), recognized }
}
