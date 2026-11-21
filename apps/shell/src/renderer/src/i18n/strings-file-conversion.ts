import { createI18n, defineStrings } from '@genoffice/i18n'
import { ar } from './file-conversion/ar'
import { cs } from './file-conversion/cs'
import { de } from './file-conversion/de'
import { en } from './file-conversion/en'
import { es } from './file-conversion/es'
import { fr } from './file-conversion/fr'
import { he } from './file-conversion/he'
import { hi } from './file-conversion/hi'
import { id } from './file-conversion/id'
import { it } from './file-conversion/it'
import { ja } from './file-conversion/ja'
import { ko } from './file-conversion/ko'
import { ms } from './file-conversion/ms'
import { nl } from './file-conversion/nl'
import { pl } from './file-conversion/pl'
import { pt } from './file-conversion/pt'
import { ru } from './file-conversion/ru'
import { th } from './file-conversion/th'
import { vi } from './file-conversion/vi'
import { zh } from './file-conversion/zh'
import { zhTW } from './file-conversion/zh-TW'

const strings = defineStrings({
  ar,
  cs,
  de,
  en,
  es,
  fr,
  he,
  hi,
  id,
  it,
  ja,
  ko,
  ms,
  nl,
  pl,
  pt,
  ru,
  th,
  vi,
  zh,
  'zh-TW': zhTW,
})

export type FileConversionStringKey = keyof typeof zh
export const fileConversionText = createI18n(strings)
