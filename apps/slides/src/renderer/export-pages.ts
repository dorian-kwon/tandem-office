/**
 * PDF export pages: every visible slide as vector SVG (text stays text), with
 * the whole-page PNG raster as the safety net for a page the SVG backend
 * cannot build, plus the @font-face CSS the print window needs for them.
 */
import type { RenderSlide } from '@genoffice/pptx-render'
import type { ExportPdfPage } from '../shared/ipc'
import { collectExportFontCss } from './export-fonts'
import { rasterizeSlideNode, renderSlidesToPngBase64 } from './export-render'
import { prepareExportImages } from './export-images-ready'
import { renderSlideToSvg } from './export-svg'

export interface PdfExportPages {
  pages: ExportPdfPage[]
  fontCss: string
}

export async function renderSlidesToPdfPages(
  slides: RenderSlide[],
  images: Map<string, HTMLImageElement>,
): Promise<PdfExportPages> {
  const pages: ExportPdfPage[] = []
  const fonts = new Set<string>()
  const prepare = prepareExportImages(images)
  for (const [i, slide] of slides.entries()) {
    const readyImages = await prepare(slide)
    try {
      const page = await renderSlideToSvg(slide, readyImages, {
        rasterizeNode: (node) => rasterizeSlideNode(node, slide, readyImages),
        idPrefix: `p${i + 1}-`,
      })
      for (const f of page.fontFamilies) fonts.add(f)
      pages.push({ svg: page.svg })
    } catch {
      const [png] = await renderSlidesToPngBase64([slide], readyImages)
      pages.push({ png: png ?? '' })
    }
  }
  let fontCss = ''
  try {
    fontCss = await collectExportFontCss(fonts)
  } catch {
    // no embedded faces: the print window falls back to the CSS chains' system fonts
  }
  return { pages, fontCss }
}
