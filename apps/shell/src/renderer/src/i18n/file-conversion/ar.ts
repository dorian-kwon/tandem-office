import type { zh } from './zh'

export const ar = {
  title: 'تحويل الملفات',
  chooseFiles: 'اختيار الملفات',
  outputFormat: 'صيغة الإخراج',
  convert: 'تحويل',
  converting: 'جارٍ التحويل…',
  destinationHint:
    'يُحفظ كل ملف بعد تحويله في مجلد الملف الأصلي. إذا كان الاسم مستخدمًا، يُضاف رقم إلى اسم الملف الجديد.',
  noCommonFormat:
    'لا توجد صيغة إخراج مشتركة لهذه الملفات. أزل بعض الملفات من القائمة أو اختر ملفات أخرى.',
  chooseFailed: 'تعذّر فتح نافذة اختيار الملفات.',
  convertFailed: 'تعذّر إكمال تحويل الملفات.',
  saved: 'تم الحفظ',
  failed: 'تعذّر التحويل',
  removeFile: 'إزالة {name} من القائمة',
} satisfies Record<keyof typeof zh, string>
