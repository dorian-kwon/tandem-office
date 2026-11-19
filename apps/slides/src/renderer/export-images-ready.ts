import type { RenderSlide } from '@genoffice/pptx-render'
import { createImageLoader } from './image-loader'
import { slideImageUrls } from './slide-image-urls'

/** Offscreen consumers can request pages the user has never visited. Keep only the
 * previous page's additional images between captures (e.g. a repeated master logo). */
export function prepareExportImages(
  cached: ReadonlyMap<string, HTMLImageElement>,
  signal?: AbortSignal,
) {
  let previous = new Map<string, HTMLImageElement>()
  return async (slide: RenderSlide) => {
    signal?.throwIfAborted()
    const page = new Map<string, HTMLImageElement>()
    const missing: string[] = []
    for (const url of slideImageUrls(slide)) {
      const image = cached.get(url) ?? previous.get(url)
      if (image) page.set(url, image)
      else missing.push(url)
    }
    if (missing.length) {
      const loader = createImageLoader((entries) => {
        for (const [url, image] of entries) page.set(url, image)
      })
      signal?.addEventListener('abort', loader.dispose, { once: true })
      try {
        loader.load(missing)
        await loader.whenIdle()
        signal?.throwIfAborted()
      } finally {
        signal?.removeEventListener('abort', loader.dispose)
        loader.dispose()
      }
    }
    previous = page
    return page
  }
}
