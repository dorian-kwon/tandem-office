/** One-based, inclusive page numbers. A blank field selects the entire document. */
export function ocrPageSelection(
  range: string | undefined,
  count: number,
): Set<number> | undefined {
  if (range === undefined || range.trim() === '') return undefined
  if (range.length > 1024) throw new Error('OCR_PAGE_RANGE')
  const spans = range.split(',').map((part) => {
    const match = /^(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(part.trim())
    if (!match) throw new Error('OCR_PAGE_RANGE')
    const start = Number(match[1])
    const end = Number(match[2] ?? match[1])
    if (start < 1 || end < start || end > count) throw new Error('OCR_PAGE_RANGE')
    return [start, end] as const
  })
  const pages = new Set<number>()
  let last = 0
  for (const [start, end] of spans.sort((a, b) => a[0] - b[0])) {
    for (let page = Math.max(start, last + 1); page <= end; page++) pages.add(page)
    last = Math.max(last, end)
  }
  return pages
}
