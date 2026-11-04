import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import type { OcrPageImage } from '../../../shared/translate-ocr'
import type { TranslateApi } from '../../../shared/translate-api'
import { useI18n } from '../locale'
import { makeText } from './shared'

export interface LightboxItem {
  index: number
  name: string
  location?: string | undefined
}

/** bytes to a data URL, for a local image shown inside this window only */
export function ocrImageDataUrl(image: OcrPageImage): string {
  const bytes = new Uint8Array(image.data)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `data:${image.mime};base64,${btoa(binary)}`
}

/**
 * A larger look at one listed picture, inside the popup. The picture comes from the bounded
 * local large-preview channel (never the AI input), so nothing here sends anything anywhere.
 * Left/Right (or the arrow buttons) move between pictures; Esc closes this view only; the
 * zoom button switches between fit-to-width (a tall strip scrolls vertically) and actual size
 * (drag or scroll to pan).
 */
export function OcrImageLightbox(props: {
  api: TranslateApi
  token: string
  items: LightboxItem[]
  /** the 1-based picture number to open on */
  start: number
  onClose: () => void
}) {
  const { lang } = useI18n()
  const s = makeText(lang)
  const { items, api, token } = props
  const [position, setPosition] = useState(() =>
    Math.max(
      0,
      items.findIndex((item) => item.index === props.start),
    ),
  )
  const [src, setSrc] = useState<string | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'none'>('loading')
  const [zoom, setZoom] = useState<'fit' | 'actual'>('fit')
  const root = useRef<HTMLDivElement>(null)
  const view = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const item = items[position]

  useEffect(() => {
    root.current?.focus()
  }, [])

  useEffect(() => {
    if (!item) return
    let alive = true
    setState('loading')
    setSrc(null)
    if (view.current) {
      view.current.scrollTop = 0
      view.current.scrollLeft = 0
    }
    const done = (image: OcrPageImage | null) => {
      if (!alive) return
      if (!image || image.data.length === 0) setState('none')
      else {
        setSrc(ocrImageDataUrl(image))
        setState('ready')
      }
    }
    if (typeof api.ocrPreviewLarge !== 'function') done(null)
    else api.ocrPreviewLarge({ token, index: item.index }).then(done, () => done(null))
    return () => {
      alive = false
    }
  }, [api, token, item?.index])

  if (!item) return null
  const go = (delta: number) =>
    setPosition((p) => Math.min(items.length - 1, Math.max(0, p + delta)))

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') {
      // only this view closes; the dialog behind it stays
      event.preventDefault()
      event.stopPropagation()
      props.onClose()
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      event.stopPropagation()
      go(1)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      event.stopPropagation()
      go(-1)
    }
  }
  const onPointerDown = (event: ReactPointerEvent) => {
    if (zoom !== 'actual' || !view.current) return
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      left: view.current.scrollLeft,
      top: view.current.scrollTop,
    }
  }
  const onPointerMove = (event: ReactPointerEvent) => {
    const d = drag.current
    if (!d || !view.current) return
    view.current.scrollLeft = d.left - (event.clientX - d.x)
    view.current.scrollTop = d.top - (event.clientY - d.y)
  }
  const endDrag = () => {
    drag.current = null
  }

  const where = item.location ? ` · ${item.location}` : ''
  return (
    <div
      ref={root}
      className="translate-ocr-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={s('ocrLightboxTitle', { n: item.index, total: items.length })}
      tabIndex={-1}
      data-lightbox=""
      data-index={item.index}
      onKeyDown={onKeyDown}
    >
      <div className="translate-ocr-lightbox-bar">
        <strong>{s('ocrLightboxTitle', { n: item.index, total: items.length })}</strong>
        <span className="translate-ocr-lightbox-where">{where}</span>
        <span className="translate-ocr-lightbox-spacer" />
        <button
          type="button"
          className="btn btn-secondary"
          data-action="prev"
          disabled={position === 0}
          onClick={() => go(-1)}
          aria-label={s('ocrLightboxPrev')}
          title={s('ocrLightboxPrev')}
        >
          ‹
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          data-action="next"
          disabled={position === items.length - 1}
          onClick={() => go(1)}
          aria-label={s('ocrLightboxNext')}
          title={s('ocrLightboxNext')}
        >
          ›
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          data-action="zoom"
          onClick={() => setZoom((z) => (z === 'fit' ? 'actual' : 'fit'))}
        >
          {zoom === 'fit' ? s('ocrLightboxActual') : s('ocrLightboxFit')}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          data-action="close"
          onClick={props.onClose}
        >
          {s('ocrLightboxClose')}
        </button>
      </div>
      <div
        ref={view}
        className="translate-ocr-lightbox-view"
        data-lightbox-view=""
        data-zoom={zoom}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
      >
        {state === 'loading' && <p role="status">{s('ocrLoading')}</p>}
        {state === 'none' && (
          <p data-lightbox-empty="" className="projects-hint">
            {s('ocrLightboxNone')}
          </p>
        )}
        {state === 'ready' && src && (
          <img src={src} alt={item.name} draggable={false} className="translate-ocr-lightbox-img" />
        )}
      </div>
    </div>
  )
}
