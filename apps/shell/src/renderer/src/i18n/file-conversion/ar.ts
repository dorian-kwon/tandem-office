import type { zh } from './zh'

export const ar = {
  ocrLanguage: 'لغة التعرّف',
  ocrLanguageDefault: 'إعداد النظام الافتراضي',
  ocrLanguageUnavailable:
    'لغة التعرّف المحددة غير متاحة. اختر لغة أخرى أو ثبّت هذه اللغة على جهازك.',
  ocrTitle: 'تشغيل التعرف الضوئي',
  ocrBatch: 'بدء التعرّف الدفعي على النصوص',
  ocrPdf: 'PDF قابل للبحث',
  ocrWord: 'Word قابل للتحرير',
  ocrRunning: 'جارٍ التعرف على النص…',
  ocrNoText: 'لم يُعثر على نص مقروء.',
  ocrUnavailable: 'التعرف الضوئي المحلي غير متاح على هذا الجهاز.',
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
  ocrRange: 'الصفحات المراد التعرّف عليها',
  ocrAllPages: 'كل الصفحات',
  ocrRangeInvalid: 'تحقق من نطاق الصفحات لهذا الملف. مثال: 1, 3–5',
} satisfies Record<keyof typeof zh, string>
