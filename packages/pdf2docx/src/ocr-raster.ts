import type { ExtractedImage } from './extract'
import { encodeRgbaPng } from './extract/png'
import type { Rect } from './geometry'
import type { RawPath } from './ir'

export interface RasterPixels {
  rgba: Uint8Array
  width: number
  height: number
}

function crop(
  pixels: RasterPixels,
  left: number,
  top: number,
  width: number,
  height: number,
): RasterPixels {
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const start = ((top + y) * pixels.width + left) * 4
    rgba.set(pixels.rgba.subarray(start, start + width * 4), y * width * 4)
  }
  return { rgba, width, height }
}

// The renderer uses top-left pixels. OCR and the PDF layout use bottom-left points.
function pixelRect(box: Rect, pixels: RasterPixels, w: number, h: number): Rect {
  return {
    x0: Math.max(0, Math.floor((box.x0 / w) * pixels.width)),
    x1: Math.min(pixels.width, Math.ceil((box.x1 / w) * pixels.width)),
    y0: Math.max(0, Math.floor((1 - box.y1 / h) * pixels.height)),
    y1: Math.min(pixels.height, Math.ceil((1 - box.y0 / h) * pixels.height)),
  }
}

/** A sign in a photo is part of the photo. Check the raster at that location,
 * since white margins around a photo can dominate a whole page's paper share. */
export function hasPaper(
  pixels: RasterPixels,
  box: Rect,
  w: number,
  h: number,
  threshold = 210,
): boolean {
  const r = pixelRect(box, pixels, w, h)
  const step = Math.max(1, Math.floor(Math.min(r.x1 - r.x0, r.y1 - r.y0) / 32))
  let total = 0,
    paper = 0
  for (let y = r.y0; y < r.y1; y += step)
    for (let x = r.x0; x < r.x1; x += step) {
      const i = (y * pixels.width + x) * 4
      if (Math.min(pixels.rgba[i]!, pixels.rgba[i + 1]!, pixels.rgba[i + 2]!) >= threshold) paper++
      total++
    }
  return total > 0 && paper / total >= 0.45
}

interface Rule {
  at: number
  from: number
  to: number
  thick: number
}

/** Only long, thin, intersecting dark runs qualify as editable table rulings.
 * Dense photographs and filled rectangles never qualify as thin strokes. */
function rules(px: RasterPixels, horizontal: boolean, minimum: number, darkMax: number): Rule[] {
  const length = horizontal ? px.width : px.height
  const rows = horizontal ? px.height : px.width
  const found: Rule[] = []
  let active: Rule[] = []
  for (let row = 0; row < rows; row++) {
    const next: Rule[] = []
    let from = 0
    for (let col = 0; col <= length; col++) {
      const i = (horizontal ? row * px.width + col : col * px.width + row) * 4
      if (col < length && Math.max(px.rgba[i]!, px.rgba[i + 1]!, px.rgba[i + 2]!) <= darkMax)
        continue
      if (col - from >= minimum) {
        const prior = active.find((r) => Math.abs(r.from - from) <= 2 && Math.abs(r.to - col) <= 2)
        if (prior) {
          prior.thick++
          next.push(prior)
        } else {
          const rule = { at: row, from, to: col, thick: 1 }
          next.push(rule)
          found.push(rule)
          if (found.length > 2048) return []
        }
      }
      from = col + 1
    }
    active = next
  }
  return found.filter((r) => r.thick <= 8)
}

export function recoverRasterArt(
  pixels: RasterPixels,
  region: Rect,
  erased: Rect[],
  w: number,
  h: number,
  grayPaperThreshold?: number,
): { images: ExtractedImage[]; paths: RawPath[] } {
  const r = pixelRect(region, pixels, w, h)
  if (r.x1 <= r.x0 || r.y1 <= r.y0) return { images: [], paths: [] }
  const px = crop(pixels, r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0)
  const sx = w / pixels.width,
    sy = h / pixels.height
  const paths: RawPath[] = []
  const darkMax = grayPaperThreshold === undefined ? 140 : Math.max(140, grayPaperThreshold - 4)
  const bands = rules(px, true, Math.max(14, Math.ceil(18 / sx)), darkMax)
  const cols = rules(px, false, Math.max(14, Math.ceil(14 / sy)), darkMax)
  const intersects = (a: Rule, b: Rule) =>
    a.from - 2 <= b.at && b.at <= a.to + 2 && b.from - 2 <= a.at && a.at <= b.to + 2
  // A photo of windows or a chart can have a perfect grid, too. Only promote
  // a connected grid of rulings when at least two recognized entries lie inside.
  const parent = Array.from({ length: bands.length + cols.length }, (_, i) => i)
  const root = (id: number): number => {
    while (parent[id] !== id) {
      parent[id] = parent[parent[id]!]!
      id = parent[id]!
    }
    return id
  }
  const crossings = new Map<Rule, number>()
  for (const [row, a] of bands.entries()) {
    for (const [col, b] of cols.entries()) {
      if (!intersects(a, b)) continue
      parent[root(row)] = root(bands.length + col)
      crossings.set(a, (crossings.get(a) ?? 0) + 1)
      crossings.set(b, (crossings.get(b) ?? 0) + 1)
    }
  }
  const grids = new Map<number, { rows: Rule[]; cols: Rule[] }>()
  for (const [id, rule] of [...bands, ...cols].entries()) {
    if ((crossings.get(rule) ?? 0) < 2) continue
    const key = root(id)
    const group = grids.get(key) ?? { rows: [], cols: [] }
    ;(id < bands.length ? group.rows : group.cols).push(rule)
    grids.set(key, group)
  }
  function whiten(x0: number, y0: number, x1: number, y1: number): void {
    x0 = Math.max(0, x0)
    x1 = Math.min(px.width, x1)
    if (x0 >= x1) return
    for (let y = Math.max(0, y0); y < Math.min(px.height, y1); y++)
      px.rgba.fill(255, (y * px.width + x0) * 4, (y * px.width + x1) * 4)
  }
  function pagePoint(x: number, y: number) {
    return { x: (r.x0 + x) * sx, y: h - (r.y0 + y) * sy }
  }
  for (const { rows: gridRows, cols: gridCols } of grids.values()) {
    if (gridRows.length < 2 || gridCols.length < 2 || gridRows.length + gridCols.length < 5)
      continue
    const left = gridCols[0]!.at,
      right = gridCols.at(-1)!.at
    const top = gridRows[0]!.at,
      bottom = gridRows.at(-1)!.at
    const entries = erased.filter((box) => {
      const e = pixelRect(box, pixels, w, h)
      const x = (e.x0 + e.x1) / 2 - r.x0,
        y = (e.y0 + e.y1) / 2 - r.y0
      return x > left && x < right && y > top && y < bottom
    })
    if (entries.length < 2) continue
    const add = (line: Rule, horizontal: boolean) => {
      const center = line.at + line.thick / 2
      const points = horizontal
        ? [pagePoint(line.from, center), pagePoint(line.to, center)]
        : [pagePoint(center, line.from), pagePoint(center, line.to)]
      paths.push({
        subpaths: [{ points, closed: false, hasCurves: false }],
        filled: false,
        stroked: true,
        strokeWidth: line.thick * (horizontal ? sy : sx),
        strokeColor: '333333',
        fillColor: '000000',
      })
      if (horizontal) whiten(line.from - 1, line.at - 1, line.to + 1, line.at + line.thick + 1)
      else whiten(line.at - 1, line.from - 1, line.at + line.thick + 1, line.to + 1)
    }
    gridRows.forEach((line) => add(line, true))
    gridCols.forEach((line) => add(line, false))
  }
  for (const box of erased) {
    const e = pixelRect(box, pixels, w, h)
    whiten(e.x0 - r.x0 - 1, e.y0 - r.y0 - 1, e.x1 - r.x0 + 1, e.y1 - r.y0 + 1)
  }
  // Keep the remaining printed area (including artwork and unrecognized text)
  // in its original position. Trim empty paper so it cannot occupy the text flow.
  let left = px.width,
    right = -1,
    top = px.height,
    bottom = -1
  for (let y = 0; y < px.height; y++)
    for (let x = 0; x < px.width; x++) {
      const i = (y * px.width + x) * 4
      if (Math.min(px.rgba[i]!, px.rgba[i + 1]!, px.rgba[i + 2]!) >= (grayPaperThreshold ?? 228))
        continue
      left = Math.min(left, x)
      right = Math.max(right, x)
      top = Math.min(top, y)
      bottom = Math.max(bottom, y)
    }
  if (right < left || bottom < top) return { images: [], paths }
  const art = crop(px, left, top, right - left + 1, bottom - top + 1)
  const start = pagePoint(left, bottom + 1),
    end = pagePoint(right + 1, top)
  return {
    paths,
    images: [
      {
        box: { x0: start.x, y0: start.y, x1: end.x, y1: end.y },
        pixelWidth: art.width,
        pixelHeight: art.height,
        mime: 'image/png',
        data: encodeRgbaPng(art.rgba, art.width, art.height),
      },
    ],
  }
}
