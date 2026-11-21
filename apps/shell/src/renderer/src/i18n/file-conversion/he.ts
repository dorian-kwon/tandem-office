import type { zh } from './zh'

export const he = {
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
} satisfies Record<keyof typeof zh, string>
