import type { zh } from './zh'

export const hi = {
  ocrLanguage: 'पहचान की भाषा',
  ocrLanguageDefault: 'सिस्टम डिफ़ॉल्ट',
  ocrLanguageUnavailable:
    'चुनी गई भाषा उपलब्ध नहीं है। कोई दूसरी भाषा चुनें या इस डिवाइस पर भाषा इंस्टॉल करें।',
  ocrTitle: 'OCR चलाएँ',
  ocrBatch: 'बैच OCR शुरू करें',
  ocrPdf: 'खोज योग्य PDF',
  ocrWord: 'संपादन योग्य Word',
  ocrRunning: 'टेक्स्ट पहचाना जा रहा है…',
  ocrNoText: 'पढ़ने योग्य टेक्स्ट नहीं मिला।',
  ocrUnavailable: 'इस डिवाइस पर स्थानीय OCR उपलब्ध नहीं है।',
  title: 'फ़ाइल रूपांतरण',
  chooseFiles: 'फ़ाइलें चुनें',
  outputFormat: 'आउटपुट फ़ॉर्मैट',
  convert: 'बदलें',
  converting: 'रूपांतरण जारी है…',
  destinationHint:
    'हर नई फ़ाइल उसकी मूल फ़ाइल वाले फ़ोल्डर में सहेजी जाती है। अगर उसी नाम की फ़ाइल पहले से मौजूद है, तो नई फ़ाइल के नाम में एक संख्या जोड़ दी जाती है।',
  noCommonFormat:
    'चुनी गई सभी फ़ाइलों के लिए कोई साझा आउटपुट फ़ॉर्मैट नहीं है। कुछ फ़ाइलें सूची से हटाएँ या दूसरी फ़ाइलें चुनें।',
  chooseFailed: 'फ़ाइल चुनने की विंडो नहीं खुल सकी।',
  convertFailed: 'फ़ाइलों का रूपांतरण पूरा नहीं हो सका।',
  saved: 'सहेजा गया',
  failed: 'रूपांतरण विफल',
  removeFile: '{name} को सूची से हटाएँ',
  ocrRange: 'पहचान के लिए पृष्ठ',
  ocrAllPages: 'सभी पृष्ठ',
  ocrRangeInvalid: 'इस फ़ाइल की पृष्ठ सीमा जाँचें। उदाहरण: 1, 3–5',
} satisfies Record<keyof typeof zh, string>
