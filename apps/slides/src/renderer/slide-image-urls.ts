import type { RenderFill, RenderNode, RenderSlide, RenderTextLayout } from '@genoffice/pptx-render'

export function collectImageUrls(
  nodes: readonly RenderNode[],
  background?: RenderFill,
): Set<string> {
  const urls = new Set<string>()
  function fill(f?: RenderFill) {
    if (f?.kind === 'image' && f.dataUrl) urls.add(f.dataUrl)
  }
  function text(layout?: RenderTextLayout) {
    for (const line of layout?.lines ?? [])
      for (const run of line.runs) if (run.image) urls.add(run.image)
  }
  function walk(items: readonly RenderNode[]) {
    for (const n of items) {
      if (n.type === 'picture' && n.dataUrl) urls.add(n.dataUrl)
      if (n.type === 'picture' || n.type === 'shape' || n.type === 'text') fill(n.fill)
      if (n.type === 'shape' || n.type === 'text') {
        fill(n.fillOverlay)
        text(n.text)
      }
      if (n.type === 'chart') {
        fill(n.bgFill)
        fill(n.plotRect?.fill)
        for (const bar of n.bars) fill(bar.fill)
      }
      if (n.type === 'table') {
        fill(n.bgFill)
        for (const cell of n.cells) {
          fill(cell.fill)
          text(cell.text)
        }
      }
      if (n.type === 'group') walk(n.children)
    }
  }
  fill(background)
  walk(nodes)
  return urls
}

// Edits produce new RenderSlide objects. Unchanged pages can reuse their URL lists.
const bySlide = new WeakMap<RenderSlide, ReadonlySet<string>>()
export function slideImageUrls(slide: RenderSlide): ReadonlySet<string> {
  let urls = bySlide.get(slide)
  if (!urls) {
    urls = collectImageUrls(slide.nodes, slide.background)
    bySlide.set(slide, urls)
  }
  return urls
}

export function viewportImageUrls(
  slides: readonly RenderSlide[],
  indices: Iterable<number>,
): Set<string> {
  const urls = new Set<string>()
  for (const index of new Set(indices)) {
    const slide = slides[index]
    if (slide) for (const url of slideImageUrls(slide)) urls.add(url)
  }
  return urls
}
