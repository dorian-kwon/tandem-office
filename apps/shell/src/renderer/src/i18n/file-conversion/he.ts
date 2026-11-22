import type { zh } from './zh'

export const he = {
  ocrLanguage: 'שפת זיהוי',
  ocrLanguageDefault: 'ברירת המחדל של המערכת',
  ocrLanguageUnavailable: 'שפת הזיהוי שנבחרה אינה זמינה. יש לבחור שפה אחרת או להתקין אותה במכשיר.',
  ocrTitle: 'הפעלת זיהוי תווים',
  ocrBatch: 'הפעלת OCR לכל הקבצים',
  ocrPdf: 'PDF הניתן לחיפוש',
  ocrWord: 'Word הניתן לעריכה',
  ocrRunning: 'מתבצע זיהוי טקסט…',
  ocrNoText: 'לא נמצא טקסט קריא.',
  ocrUnavailable: 'זיהוי טקסט מקומי אינו זמין במכשיר זה.',
  title: 'המרת קבצים',
  chooseFiles: 'בחירת קבצים',
  outputFormat: 'פורמט פלט',
  convert: 'המרה',
  converting: 'ההמרה מתבצעת…',
  destinationHint:
    'כל קובץ שהומר נשמר בתיקייה של קובץ המקור שלו. אם השם כבר בשימוש, יתווסף מספר לשם הקובץ החדש.',
  noCommonFormat:
    'אין פורמט פלט משותף לכל הקבצים שנבחרו. אפשר להסיר חלק מהם מהרשימה או לבחור קבצים אחרים.',
  chooseFailed: 'לא ניתן לפתוח את חלון בחירת הקבצים.',
  convertFailed: 'לא ניתן להשלים את המרת הקבצים.',
  saved: 'נשמר',
  failed: 'ההמרה נכשלה',
  removeFile: 'הסרת {name} מהרשימה',
  ocrRange: 'עמודים לזיהוי',
  ocrAllPages: 'כל העמודים',
  ocrRangeInvalid: 'יש לבדוק את טווח העמודים בקובץ. לדוגמה: 1, 3–5',
} satisfies Record<keyof typeof zh, string>
