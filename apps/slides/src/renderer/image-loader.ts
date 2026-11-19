/**
 * Incremental image loading: each decoded image is surfaced in small batches
 * instead of waiting for the whole deck (385 pictures used to render nothing
 * until the last one settled). Loaded/in-flight urls are tracked across calls
 * so re-collecting urls after an edit never reloads or discards progress.
 */
import { metafileToDataUrl } from '@genoffice/docx-engine/metafile'

/** Slide media is cross-origin: without CORS a canvas that draws it is tainted (cutout, export). */
export function setImageSource(img: HTMLImageElement, url: string): void {
  if (url.startsWith('genoffice-slide-media:')) img.crossOrigin = 'anonymous'
  img.src = url
}

export type ApplyImages = (entries: ReadonlyArray<readonly [string, HTMLImageElement]>) => void

/** EMF/WMF data URLs: browsers cannot decode metafiles — rasterize to PNG first (keyed by the original url). */
const METAFILE_RE = /^data:(image\/x-(?:emf|wmf)|image\/(?:emf|wmf));base64,/
const LAZY_METAFILE_RE = /^genoffice-slide-media:.*[?&]mime=image%2F(?:x-)?(emf|wmf)(?:&|$)/i

/**
 * EMF headers size the raster from their device bounds, up to the converter's 8192px cap:
 * a 409-slide deck with 67 metafiles held 2.7 GB of 268 MB canvases. A slide picture never
 * shows above ~2x slide width, so cap the longest side.
 */
export const MAX_METAFILE_RASTER_PX = 2048
/** Base64 budget for metafile raster input (~40MB of bytes). */
export const MAX_METAFILE_BASE64_CHARS = 56 * 1024 * 1024

/**
 * Metafile text draws through canvas fonts, so the Office-private FontFaces (DFonts/cloud/
 * embedded, registered by doc-fonts.ts after the deck settles) must be in place first — an
 * EMF rasterized before that keeps its fallback face forever (Excel OLE previews in
 * Meiryo UI came out in the browser's default sans). `false` = a sync is in flight.
 */
function waitForDocFonts(timeoutMs = 4000): Promise<void> {
  if (typeof window === 'undefined' || window.__genofficeDocFontsSynced !== false)
    return Promise.resolve()
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = () => {
      if (window.__genofficeDocFontsSynced !== false || Date.now() - started >= timeoutMs) resolve()
      else setTimeout(tick, 50)
    }
    setTimeout(tick, 50)
  })
}

async function rasterizeMetafile(url: string): Promise<string | null> {
  const m = METAFILE_RE.exec(url)
  const lazy = LAZY_METAFILE_RE.exec(url)
  if (!m && !lazy) return null
  await waitForDocFonts()
  if (lazy) {
    const response = await fetch(url)
    if (!response.ok) return null
    const maxBytes = Math.floor((MAX_METAFILE_BASE64_CHARS * 3) / 4)
    const size = Number(response.headers.get('Content-Length'))
    if (size > maxBytes) return null
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) return null
    return metafileToDataUrl(bytes, `image/x-${lazy[1]!.toLowerCase()}`, {
      maxSidePx: MAX_METAFILE_RASTER_PX,
    })
  }
  const b64 = url.slice(url.indexOf(',') + 1)
  // atob + Uint8Array double-allocate the payload on the main thread: refuse
  // huge metafiles before decoding (mirrors the 40MB PNG cap in element-clipboard).
  if (b64.length > MAX_METAFILE_BASE64_CHARS) return null
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const mime = m![1]!.includes('emf') ? 'image/x-emf' : 'image/x-wmf'
  return metafileToDataUrl(bytes, mime, { maxSidePx: MAX_METAFILE_RASTER_PX })
}

const MAX_CONCURRENT_IMAGES = 4

export function createImageLoader(apply: ApplyImages, batchSize = 16, delayMs = 100) {
  const settled = new Set<string>()
  const loading = new Set<string>()
  const queue = new Set<string>()
  const buf = new Map<string, HTMLImageElement>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  const progress = new Set<() => void>()

  const flush = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (disposed || buf.size === 0) return
    const entries = [...buf]
    buf.clear()
    apply(entries)
  }

  function pump() {
    while (!disposed && loading.size < MAX_CONCURRENT_IMAGES && queue.size > 0) {
      const u = queue.values().next().value!
      queue.delete(u)
      loading.add(u)
      const img = new Image()
      const done = (ok: boolean) => {
        img.onload = img.onerror = null
        loading.delete(u)
        if (disposed) return
        settled.add(u)
        if (ok) buf.set(u, img)
        pump()
        if (buf.size >= batchSize || (loading.size === 0 && queue.size === 0)) flush()
        else if (!timer && buf.size > 0) timer = setTimeout(flush, delayMs)
        for (const update of progress) update()
      }
      img.onload = () => done(true)
      img.onerror = () => done(false)
      if (METAFILE_RE.test(u) || LAZY_METAFILE_RE.test(u)) {
        void rasterizeMetafile(u)
          .then((png) => {
            if (png && !disposed) img.src = png
            else done(false)
          })
          .catch(() => done(false))
      } else {
        setImageSource(img, u)
      }
    }
  }

  return {
    pending(): number {
      return loading.size + queue.size
    },
    /** A large healthy page may take many batches. Only time out when none settles. */
    whenIdle(stallMs = 30_000): Promise<void> {
      if (disposed || (!queue.size && !loading.size)) return Promise.resolve()
      return new Promise((resolve, reject) => {
        let timeout: ReturnType<typeof setTimeout>
        const update = () => {
          clearTimeout(timeout)
          if (disposed || (!queue.size && !loading.size)) {
            progress.delete(update)
            resolve()
          } else {
            timeout = setTimeout(() => {
              progress.delete(update)
              reject(new Error('Slide images stopped loading'))
            }, stallMs)
          }
        }
        progress.add(update)
        update()
      })
    },
    /** Replace work that hasn't started with the latest viewport's priority order. */
    load(urls: Iterable<string>) {
      if (disposed) return
      queue.clear()
      for (const u of urls) if (!settled.has(u) && !loading.has(u)) queue.add(u)
      pump()
    },
    dispose() {
      disposed = true
      queue.clear()
      settled.clear()
      buf.clear()
      if (timer) clearTimeout(timer)
      for (const update of progress) update()
    },
  }
}
