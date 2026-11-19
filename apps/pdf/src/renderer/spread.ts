/** Render rows for the page list: one page per row in single mode; pairs
    1+2, 3+4, … in two-page mode (mainstream default — WPS/Acrobat/Word pair
    from the first page; a separate-cover option can layer on later) */
export function spreadRows(visList: number[], spread: 1 | 2): number[][] {
  if (spread === 1) return visList.map((i) => [i])
  const out: number[][] = []
  for (let i = 0; i < visList.length; i += 2) out.push(visList.slice(i, i + 2))
  return out
}

/** Visible position → row index */
export function rowOfVisIdx(visIdx: number, spread: 1 | 2): number {
  return spread === 1 ? visIdx : Math.floor(visIdx / 2)
}

/** Arrow/thumbnail page stepping moves one whole row (a pair in two-page mode —
    stepping a single page inside a pair would not scroll and reads as a dead key).
    `page` is the 1-based visible page number; returns the row-first page to land on. */
export function stepPage(visList: number[], spread: 1 | 2, page: number, dir: 1 | -1): number {
  const rows = spreadRows(visList, spread)
  if (rows.length === 0) return page
  const cur = rowOfVisIdx(page - 1, spread)
  const target = Math.min(Math.max(0, cur + dir), rows.length - 1)
  return visList.indexOf(rows[target]![0]!) + 1
}

/** Start offsets include the gap above the first row and between rows. */
export function rowOffsets(heights: number[], scale: number, gap: number): number[] {
  let top = gap
  return heights.map((height) => {
    const start = top
    top += height * scale + gap
    return start
  })
}

/** Visible row at the scroll anchor, clamped to the first and last row. */
export function rowAtOffset(tops: number[], anchor: number): number {
  let lo = 0
  let hi = tops.length
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (tops[mid]! <= anchor) lo = mid + 1
    else hi = mid
  }
  return Math.max(0, lo - 1)
}
