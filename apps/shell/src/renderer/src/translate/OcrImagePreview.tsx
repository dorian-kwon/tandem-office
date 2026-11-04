import { useEffect, useRef, useState } from 'react'
import type { TranslateApi } from '../../../shared/translate-api'

/** Load a small local thumbnail when its row approaches the visible list. */
export function OcrImagePreview({
  api,
  token,
  index,
  name,
}: {
  api: TranslateApi
  token: string
  index: number
  name: string
}) {
  const host = useRef<HTMLSpanElement>(null)
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    let loaded = false
    const load = () => {
      if (loaded || typeof api.ocrPreview !== 'function') return
      loaded = true
      void api
        .ocrPreview({ token, index })
        .then((image) => {
          if (!alive || !image || image.data.length > 64 * 1024 || image.mime !== 'image/png')
            return
          const bytes = new Uint8Array(image.data)
          let binary = ''
          for (const byte of bytes) binary += String.fromCharCode(byte)
          setSrc(`data:image/png;base64,${btoa(binary)}`)
        })
        .catch(() => undefined)
    }
    let observer: IntersectionObserver | undefined
    if (typeof IntersectionObserver === 'undefined') load()
    else {
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            observer?.disconnect()
            load()
          }
        },
        { root: host.current?.closest('[data-items]') ?? null, rootMargin: '100px' },
      )
      if (host.current) observer.observe(host.current)
    }
    return () => {
      alive = false
      observer?.disconnect()
    }
  }, [api, token, index])
  return (
    <span ref={host} className="translate-ocr-preview">
      {src && <img src={src} alt={name} />}
    </span>
  )
}
