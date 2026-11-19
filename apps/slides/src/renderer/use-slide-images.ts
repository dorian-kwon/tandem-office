import { useEffect, useRef, useState } from 'react'
import { createImageLoader } from './image-loader'

/** A loader belongs to one open document, including edits and changes of view. */
export function useSlideImages(urls: Iterable<string>, documentKey = 0) {
  const [images, setImages] = useState(() => new Map<string, HTMLImageElement>())
  const loader = useRef<ReturnType<typeof createImageLoader> | null>(null)
  useEffect(() => {
    const next = createImageLoader((entries) =>
      setImages((prev) => {
        const updated = new Map(prev)
        for (const [url, image] of entries) updated.set(url, image)
        return updated
      }),
    )
    loader.current = next
    setImages(new Map())
    return () => {
      next.dispose()
      loader.current = null
    }
  }, [documentKey])
  useEffect(() => {
    loader.current?.load(urls)
  }, [urls, documentKey])
  return { images, loader }
}
