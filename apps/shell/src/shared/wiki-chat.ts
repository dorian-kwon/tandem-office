import type { Lang } from '@genoffice/i18n'

/** Match a requested editing action, not a translation project or an output file name. */
export function isWikiEditingRequest(query: string | undefined): boolean {
  const text = query?.normalize('NFKC').trim().toLowerCase()
  if (!text) return false
  if (
    /(?:번역|병기|교정|교열|윤문|감수|검수|수정)(?:\s*(?:해|하자|하겠|하고|해서|부탁|시작|진행(?!률|율|\s*상[태황])|작업해|해줘|좀\s*해)|[.!?~\s]*$)|다듬(?:어|자|기)|다듬기|(?:영어|한국어|일본어|중국어|영문|국문)(?:로|으로)\s*(?:옮겨|바꿔|써\s*줘)/u.test(
      text,
    )
  )
    return true
  if (
    /(?:翻訳|翻譯|翻译|润色|潤色|推敲|校正|校对|校對)(?:して|する|をお願い|一下|为|為|成|這|这|本文|。|$)|(?:请|請)(?:幫我|帮我)?(?:翻译|翻譯|润色|潤色)|(?:訳して|訳し直|書き直して)/u.test(
      text,
    )
  )
    return true
  return /(?<![\p{L}])(translate|retranslate|polish|proofread|copyedit|refine|revise|rephrase|smooth out|traduire|traduis(?:ez)?|reformule[rz]?|relire|übersetze[n]?|überarbeite[n]?|traducir|traduce|traduzca|revisa[r]?|traduz(?:ir|a)|revisar|traduci|tradurre|rivedi|vertaal|herschrijf|przetłumacz|przeredaguj|přelož(?:it)?|přeformuluj|переведи(?:те)?|перевести|отредактируй(?:те)?|ترجم|ترجمة|صغ|תרגם|לתרגם|נסח|अनुवाद|सुधारें|terjemah(?:kan)?|sunting|dịch|hiệu đính|trau chuốt)(?![\p{L}])|แปล(?:เป็น|ให้|ข้อความ|เอกสาร|ทั้งหมด|ภาษา)|ขัดเกลา/u.test(
    text,
  )
}

/** Native editor dialogs and the project chat show the same choices. */
export const wikiChatLabels = {
  ko: ['이번 요청에 맞는 예문을 내 번역 위키에서 찾을까요?', '참고하기', '이번에는 제외'],
  en: [
    'Search the local translation wiki for examples relevant to this request?',
    'Use wiki notes',
    'Continue without them',
  ],
  ja: ['今回の依頼に合う用例をローカルの翻訳ウィキで探しますか？', '参照する', '今回は使用しない'],
  zh: ['要在本地翻译维基中查找适合此请求的例句吗？', '参考笔记', '此次不使用'],
  'zh-TW': ['要在本機翻譯維基中尋找符合這次請求的例句嗎？', '參考筆記', '這次不使用'],
  de: [
    'Das lokale Übersetzungswiki nach passenden Beispielen für diese Anfrage durchsuchen?',
    'Notizen verwenden',
    'Ohne Notizen fortfahren',
  ],
  fr: [
    'Chercher dans le wiki de traduction local des exemples adaptés à cette demande ?',
    'Utiliser les notes',
    'Continuer sans les notes',
  ],
  es: [
    '¿Buscar en la wiki de traducción local ejemplos adecuados para esta solicitud?',
    'Usar las notas',
    'Continuar sin ellas',
  ],
  pt: [
    'Buscar exemplos relevantes para esta solicitação na wiki de tradução local?',
    'Usar notas',
    'Continuar sem elas',
  ],
  it: [
    'Cercare esempi pertinenti a questa richiesta nel wiki di traduzione locale?',
    'Usa le note',
    'Continua senza',
  ],
  ru: [
    'Найти подходящие примеры для этого запроса в локальной вики переводов?',
    'Использовать',
    'Продолжить без них',
  ],
  ar: [
    'هل تريد البحث في ويكي الترجمة المحلي عن أمثلة مناسبة لهذا الطلب؟',
    'استخدام الملاحظات',
    'المتابعة بدونها',
  ],
  cs: [
    'Vyhledat v místní překladové wiki příklady vhodné pro tento požadavek?',
    'Použít poznámky',
    'Pokračovat bez nich',
  ],
  he: ['לחפש בוויקי התרגום המקומי דוגמאות מתאימות לבקשה הזו?', 'להשתמש בהערות', 'להמשיך בלעדיהן'],
  hi: [
    'इस अनुरोध के लिए स्थानीय अनुवाद विकी में प्रासंगिक उदाहरण खोजें?',
    'नोट्स का उपयोग करें',
    'इनके बिना जारी रखें',
  ],
  id: [
    'Cari contoh yang sesuai dengan permintaan ini di wiki terjemahan lokal?',
    'Gunakan catatan',
    'Lanjutkan tanpa catatan',
  ],
  ms: [
    'Cari contoh yang sesuai dengan permintaan ini dalam wiki terjemahan setempat?',
    'Gunakan nota',
    'Teruskan tanpa nota',
  ],
  nl: [
    'In de lokale vertaalwiki zoeken naar voorbeelden die bij dit verzoek passen?',
    'Notities gebruiken',
    'Doorgaan zonder notities',
  ],
  pl: [
    'Wyszukać w lokalnej wiki tłumaczeń przykłady pasujące do tego żądania?',
    'Użyj notatek',
    'Kontynuuj bez nich',
  ],
  th: [
    'ค้นหาตัวอย่างที่เหมาะกับคำขอนี้ในวิกิการแปลในเครื่องหรือไม่',
    'ใช้บันทึก',
    'ดำเนินการต่อโดยไม่ใช้',
  ],
  vi: [
    'Tìm ví dụ phù hợp với yêu cầu này trong wiki dịch thuật trên máy?',
    'Dùng ghi chú',
    'Tiếp tục mà không dùng',
  ],
} satisfies Record<Lang, [string, string, string]>
