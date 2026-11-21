import type { zh } from './zh'

export const hi = {
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
} satisfies Record<keyof typeof zh, string>
