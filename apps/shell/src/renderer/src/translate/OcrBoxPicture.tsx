import { useEffect, useState } from 'react'
import type { OcrBox } from '../../../shared/ocr-boxes'
import type { TranslateApi } from '../../../shared/translate-api'
import { useI18n } from '../locale'
import { OcrBoxEditor } from './OcrBoxEditor'
import { ocrImageDataUrl } from './OcrImageLightbox'
import { makeText } from './shared'

/** One picture of the reading with its box editor: the picture is the enlarged local preview. */
export function OcrBoxPicture({
  api,
  token,
  index,
  boxes,
  disabled,
  onChange,
}: {
  api: TranslateApi | undefined
  token: string
  index: number
  boxes: OcrBox[]
  disabled: boolean
  onChange: (boxes: OcrBox[]) => void
}) {
  const { lang } = useI18n()
  const s = makeText(lang)
  // undefined while loading, null when the picture cannot be shown
  const [src, setSrc] = useState<string | null | undefined>(undefined)
  const [selected, setSelected] = useState<number | null>(null)
  useEffect(() => {
    let alive = true
    if (!api || typeof api.ocrPreviewLarge !== 'function') {
      setSrc(null)
      return
    }
    api.ocrPreviewLarge({ token, index }).then(
      (image) => alive && setSrc(image ? ocrImageDataUrl(image) : null),
      () => alive && setSrc(null),
    )
    return () => {
      alive = false
    }
  }, [api, token, index])
  if (src === undefined) return <p role="status">{s('ocrBoxPictureLoading')}</p>
  if (src === null) return <p>{s('ocrBoxPictureMissing')}</p>
  return (
    <OcrBoxEditor
      src={src}
      boxes={boxes}
      selected={selected}
      disabled={disabled}
      onChange={onChange}
      onSelect={setSelected}
    />
  )
}
