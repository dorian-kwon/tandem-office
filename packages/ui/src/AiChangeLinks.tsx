import React from 'react'
import type { Lang } from '@genoffice/i18n'
import type { AiChangeLocation } from '@genoffice/agent-core'
import './ai-change-links.css'

const showPlace: Record<Lang, string> = {
  ar: 'إظهار هذا الموضع في المستند',
  cs: 'Zobrazit toto místo v dokumentu',
  de: 'Diese Stelle im Dokument anzeigen',
  en: 'Show this place in the document',
  es: 'Mostrar este lugar en el documento',
  fr: 'Afficher cet endroit dans le document',
  he: 'הצגת המקום הזה במסמך',
  hi: 'दस्तावेज़ में यह स्थान दिखाएँ',
  id: 'Tampilkan tempat ini di dokumen',
  it: 'Mostra questo punto nel documento',
  ja: '文書内でこの場所を表示',
  ko: '변경 위치 보기',
  ms: 'Tunjukkan tempat ini dalam dokumen',
  nl: 'Deze plaats in het document tonen',
  pl: 'Pokaż to miejsce w dokumencie',
  pt: 'Mostrar este local no documento',
  ru: 'Показать это место в документе',
  th: 'แสดงตำแหน่งนี้ในเอกสาร',
  vi: 'Hiển thị vị trí này trong tài liệu',
  'zh-TW': '在文件中檢視此處',
  zh: '在文档中查看此处',
}

function labelOf(place: AiChangeLocation): string {
  switch (place.kind) {
    case 'block':
    case 'source':
      return '#' + (place.index + 1)
    case 'page':
      return '#' + place.index
    case 'element':
      return '#' + place.index
    case 'slide':
      return '#' + (place.index + 1) + (place.node ? ' · ' + place.node : '')
    case 'cell':
      return place.sheet + '!' + place.range
    case 'book':
      return '#' + (place.chapter + 1) + ' · ' + place.block
    case 'topic':
      return place.label
  }
}

/** Navigation is only rendered on a local message that recorded an applied edit. */
export function AiChangeLinks({
  places,
  lang,
  onShow,
}: {
  places: readonly AiChangeLocation[] | undefined
  lang: Lang
  onShow: (location: AiChangeLocation) => void
}): React.JSX.Element | null {
  if (!places?.length) return null
  return (
    <details className="ai-change-links">
      <summary>{showPlace[lang]}</summary>
      <div>
        {places.map((place) => (
          <button
            type="button"
            dir="auto"
            key={JSON.stringify(place)}
            onClick={() => onShow(place)}
          >
            {labelOf(place)}
          </button>
        ))}
      </div>
    </details>
  )
}
