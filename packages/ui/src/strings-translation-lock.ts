import type { Lang } from '@genoffice/i18n'

/** The note on the translation output pane while the AI translates. */
export interface TranslationLockStrings {
  /** editing is locked until the AI finishes */
  banner: string
  /** releases the lock and stops the run */
  unlock: string
}

export const TRANSLATION_LOCK_STRINGS: Record<Lang, TranslationLockStrings> = {
  zh: { banner: 'AI 正在翻译，完成前已锁定编辑', unlock: '解锁' },
  en: { banner: 'The AI is translating; editing is locked until it finishes', unlock: 'Unlock' },
  ja: { banner: 'AIが翻訳中です。終わるまで編集はロックされます', unlock: 'ロック解除' },
  ko: { banner: 'AI가 번역하는 중입니다. 끝날 때까지 편집이 잠깁니다', unlock: '잠금 해제' },
  'zh-TW': { banner: 'AI 正在翻譯，完成前已鎖定編輯', unlock: '解除鎖定' },
  de: { banner: 'Die KI übersetzt; die Bearbeitung ist bis zum Ende gesperrt', unlock: 'Entsperren' },
  es: { banner: 'La IA está traduciendo; la edición está bloqueada hasta que termine', unlock: 'Desbloquear' },
  fr: { banner: "L'IA traduit ; la modification est verrouillée jusqu'à la fin", unlock: 'Déverrouiller' },
  pt: { banner: 'A IA está traduzindo; a edição fica bloqueada até terminar', unlock: 'Desbloquear' },
  ru: { banner: 'ИИ переводит; редактирование заблокировано до завершения', unlock: 'Разблокировать' },
  ar: { banner: 'الذكاء الاصطناعي يترجم؛ التحرير مقفل حتى ينتهي', unlock: 'فتح القفل' },
  hi: { banner: 'AI अनुवाद कर रहा है; खत्म होने तक संपादन बंद है', unlock: 'अनलॉक करें' },
  id: { banner: 'AI sedang menerjemahkan; pengeditan dikunci sampai selesai', unlock: 'Buka kunci' },
  it: { banner: "L'IA sta traducendo; la modifica è bloccata fino alla fine", unlock: 'Sblocca' },
  nl: { banner: 'De AI is aan het vertalen; bewerken is vergrendeld tot het klaar is', unlock: 'Ontgrendelen' },
  pl: { banner: 'AI tłumaczy; edycja jest zablokowana do zakończenia', unlock: 'Odblokuj' },
  th: { banner: 'AI กำลังแปลอยู่ การแก้ไขถูกล็อกจนกว่าจะเสร็จ', unlock: 'ปลดล็อก' },
  vi: { banner: 'AI đang dịch; việc chỉnh sửa bị khóa cho đến khi xong', unlock: 'Mở khóa' },
  cs: { banner: 'AI překládá; úpravy jsou zamčeny, dokud neskončí', unlock: 'Odemknout' },
  he: { banner: 'הבינה המלאכותית מתרגמת; העריכה נעולה עד שתסיים', unlock: 'שחרור נעילה' },
  ms: { banner: 'AI sedang menterjemah; pengeditan dikunci sehingga selesai', unlock: 'Buka kunci' },
}
