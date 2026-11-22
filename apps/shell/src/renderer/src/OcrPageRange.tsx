import type { Lang } from '@genoffice/i18n'
import { fileConversionText } from './i18n/strings-file-conversion'

export function OcrPageRange({
  value,
  onChange,
  disabled,
  lang,
}: {
  value: string
  onChange: (range: string) => void
  disabled: boolean
  lang: Lang
}) {
  return (
    <label className="projects-field">
      <span className="projects-field-label">{fileConversionText(lang, 'ocrRange')}</span>
      <input
        className="translate-input"
        data-testid="ocr-page-range"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        maxLength={1024}
        placeholder={fileConversionText(lang, 'ocrAllPages') + ' (1, 3–5)'}
      />
    </label>
  )
}
