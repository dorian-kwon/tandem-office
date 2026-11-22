import type { Rect } from '../../../../packages/pdf2docx/src/geometry'
import type { OcrEngine, OcrLine } from '../../../../packages/pdf2docx/src/ocr'
import type { RasterPixels } from '../../../../packages/pdf2docx/src/ocr-raster'
import {
  turnLines,
  turnPixels,
  type ScanTurn,
} from '../../../../packages/pdf2docx/src/ocr-rotation'
import { encodeRgbaPng } from '../../../../packages/pdf2docx/src/extract/png'

import { hasIsolatedScanNoise, isolatedTone } from './ocr-scan-noise'

interface ScanProfile {
  denoise: boolean
  ink: number
  paper: number
  contrast: boolean
  slope: number
}

function luminance(rgba: Uint8Array, i: number) {
  return (rgba[i]! * 77 + rgba[i + 1]! * 150 + rgba[i + 2]! * 29) >>> 8
}

// A deskewed text page concentrates dark samples into fewer horizontal rows.
// Work on a small square-pixel grid even for multi-megapixel scans.
function lineSlope(gray: Uint8Array, width: number, height: number, threshold: number): number {
  const xs: number[] = [],
    ys: number[] = []
  for (let i = 0; i < gray.length; i++) {
    if (gray[i]! <= threshold) {
      xs.push(i % width)
      ys.push(Math.floor(i / width))
    }
  }
  if (xs.length < 25 || xs.length > gray.length * 0.32) return 0
  const pad = Math.ceil(width * 0.11)
  const counts = new Uint16Array(height + 2 * pad + 1)
  function concentration(slope: number) {
    counts.fill(0)
    let score = 0
    for (let i = 0; i < xs.length; i++) {
      const row = pad + ys[i]! - Math.round(xs[i]! * slope)
      // Incremental difference between squared occupancies.
      score += 2 * counts[row]! + 1
      counts[row]!++
    }
    return score
  }
  const flat = concentration(0)
  let best = flat,
    slope = 0
  for (let degrees = -6; degrees <= 6; degrees += 0.5) {
    if (degrees === 0) continue
    const candidate = Math.tan((degrees * Math.PI) / 180)
    const score = concentration(candidate)
    if (score > best) {
      best = score
      slope = candidate
    }
  }
  return best > flat * 1.18 ? slope : 0
}

function profileScan(pixels: RasterPixels): ScanProfile | null {
  const { width, height, rgba } = pixels
  const step = Math.max(1, Math.ceil(Math.max(width, height) / 384))
  const cols = Math.ceil(width / step),
    rows = Math.ceil(height / step)
  const gray = new Uint8Array(rows * cols)
  const hist = new Uint32Array(256)
  let count = 0,
    colorful = 0
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const at = (y * width + x) * 4
      const r = rgba[at]!,
        g = rgba[at + 1]!,
        b = rgba[at + 2]!
      if (Math.max(r, g, b) - Math.min(r, g, b) > 28) colorful++
      gray[count++] = luminance(rgba, at)
      hist[gray[count - 1]!]!++
    }
  }
  if (!count || colorful > count * 0.25) return null
  const percentile = (fraction: number) => {
    let total = 0
    for (let v = 0; v < 255; v++) {
      total += hist[v]!
      if (total >= count * fraction) return v
    }
    return 255
  }
  const ink = percentile(0.01),
    paper = percentile(0.85)
  // Require a dominant, near-uniform paper field and some distinguishable ink.
  if (paper < 105 || paper - ink < 12 || percentile(0.4) < paper - 18) return null
  return {
    ink,
    paper,
    denoise: hasIsolatedScanNoise(pixels),
    // A white background can hide faded ink in downsampled office scans.
    // Stretch the gray levels when at least a fifth of their range is unused,
    // keeping the intermediate tones that define small glyphs and punctuation.
    contrast: paper - ink < 0.8 * 255 || paper < 200,
    // A tiny thumbnail has too few independent rows to estimate a baseline reliably.
    slope: Math.min(cols, rows) < 64 ? 0 : lineSlope(gray, cols, rows, ink + (paper - ink) * 0.48),
  }
}

function correctedRaster(pixels: RasterPixels, plan: ScanProfile) {
  const { width, height, rgba } = pixels
  // Extend the working canvas so even text touching a corner survives deskew.
  const pad = Math.ceil((Math.abs(plan.slope) * width) / 2)
  const outHeight = height + 2 * pad
  const out = new Uint8Array(width * outHeight * 4).fill(255)
  const shift = Int32Array.from(
    { length: width },
    (_, x) => pad - Math.round((x - width / 2) * plan.slope),
  )
  const tone = Uint8ClampedArray.from({ length: 256 }, (_, i) =>
    plan.contrast ? ((i - plan.ink) * 255) / (plan.paper - plan.ink) : i,
  )
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = ((y + shift[x]!) * width + x) * 4
      const gray = luminance(rgba, (y * width + x) * 4)
      const v = tone[plan.denoise ? isolatedTone(pixels, x, y, gray) : gray]!
      out[at] = v
      out[at + 1] = v
      out[at + 2] = v
    }
  }
  return { pad, outHeight, bytes: encodeRgbaPng(out, width, outHeight) }
}

// Native engines can recognize a sideways or upside-down page in one pass.
// Compare the first/last character positions in recognized reading order to
// recover the direction of the baseline. A normal RTL line travels leftward.
function recognizedTurn(lines: OcrLine[], width: number, height: number): ScanTurn | undefined {
  const votes = new Map<0 | ScanTurn, number>()
  let total = 0
  for (const line of lines) {
    if (!line.chars || line.chars.length < 3 || line.confidence < 0.55) continue
    const chars = line.chars.filter(
      (c) => c.text.trim() && c.box.x1 > c.box.x0 && c.box.y1 > c.box.y0,
    )
    const a = chars[0]?.box,
      b = chars.at(-1)?.box
    if (!a || !b) continue
    const initial = line.text.match(/\p{L}/u)?.[0]
    if (!initial) continue
    const direction =
      /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u.test(
        initial,
      )
        ? -1
        : 1
    const dx = (b.x0 + b.x1 - a.x0 - a.x1) * width * direction
    const dy = (b.y0 + b.y1 - a.y0 - a.y1) * height * direction
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 4) continue
    const turn =
      Math.abs(dx) > Math.abs(dy) * 1.8
        ? dx < 0
          ? 180
          : 0
        : Math.abs(dy) > Math.abs(dx) * 1.8
          ? dy > 0
            ? 90
            : 270
          : undefined
    if (turn === undefined) continue
    votes.set(turn, (votes.get(turn) ?? 0) + chars.length)
    total += chars.length
  }
  for (const [turn, vote] of votes) if (turn && vote >= total * 0.8) return turn
}

export function prepareScanOcr(engine: OcrEngine): OcrEngine {
  const cache = new WeakMap<Uint8Array, ScanProfile | null>()
  function profile(pixels: RasterPixels) {
    if (!cache.has(pixels.rgba)) {
      try {
        cache.set(pixels.rgba, profileScan(pixels))
      } catch {
        cache.set(pixels.rgba, null)
      }
    }
    return cache.get(pixels.rgba)
  }
  const wrapped: OcrEngine = (png, page, pixels) => {
    if (!pixels) return engine(png, page)
    const plan = profile(pixels)
    if (!plan || (!plan.contrast && !plan.slope && !plan.denoise)) return engine(png, page)
    let prepared: ReturnType<typeof correctedRaster>
    try {
      prepared = correctedRaster(pixels, plan)
    } catch {
      // Working bitmap allocation or PNG encoding can fail on a constrained device.
      return engine(png, page)
    }
    const { width, height } = pixels
    const { pad, outHeight, bytes } = prepared
    const read = engine(bytes, {
      ...page,
      heightPt: (page.heightPt * outHeight) / height,
    })
    if (!read?.lines.length) return engine(png, page)
    if (!pad) return read
    const clamp = (n: number) => Math.min(1, Math.max(0, n))
    const restore = (box: Rect): Rect => {
      const dx0 = (box.x0 - 0.5) * width * plan.slope
      const dx1 = (box.x1 - 0.5) * width * plan.slope
      return {
        x0: box.x0,
        x1: box.x1,
        y0: clamp((box.y0 * outHeight - pad - Math.max(dx0, dx1)) / height),
        y1: clamp((box.y1 * outHeight - pad - Math.min(dx0, dx1)) / height),
      }
    }
    return {
      ...read,
      lines: read.lines.map((line) => ({
        ...line,
        box: restore(line.box),
        ...(line.chars && { chars: line.chars.map((c) => ({ ...c, box: restore(c.box) })) }),
      })),
    }
  }
  wrapped.paperThreshold = (pixels) => {
    const plan = profile(pixels)
    return plan?.contrast ? Math.min(210, plan.paper - 18) : 210
  }
  const oriented: OcrEngine = (png, page, pixels) => {
    const first = wrapped(png, page, pixels)
    const useful = (lines: NonNullable<ReturnType<OcrEngine>>['lines']) =>
      lines.reduce(
        (n, l) => n + (l.confidence >= 0.65 ? (l.text.match(/[\p{L}\p{N}]/gu)?.length ?? 0) : 0),
        0,
      )
    // Keep native geometry whenever the original already produced readable text.
    if (!pixels || !first) return first
    if (useful(first.lines) > 0) {
      const turn = recognizedTurn(first.lines, page.widthPt, page.heightPt)
      return turn ? { ...first, uprightTurn: turn } : first
    }
    const p = profile(pixels)
    if (!p || Math.min(pixels.width, pixels.height) < 64) return first
    for (const turn of [90, 270, 180] as const) {
      const uprightPage = turn === 180 ? page : { widthPt: page.heightPt, heightPt: page.widthPt }
      let candidate
      try {
        const upright = turnPixels(pixels, turn)
        const corrected = encodeRgbaPng(upright.rgba, upright.width, upright.height)
        candidate = wrapped(corrected, uprightPage, upright)
      } catch {
        continue
      }
      if (!candidate || useful(candidate.lines) < 3) continue
      const extraTurn =
        recognizedTurn(candidate.lines, uprightPage.widthPt, uprightPage.heightPt) ?? 0
      const totalTurn = (turn + extraTurn) % 360
      return {
        ...candidate,
        lines: turnLines(candidate.lines, (360 - turn) as ScanTurn),
        uprightTurn: totalTurn === 0 ? undefined : (totalTurn as ScanTurn),
      }
    }
    return first
  }
  oriented.paperThreshold = wrapped.paperThreshold
  return oriented
}
