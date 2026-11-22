import type { zh } from './zh'

export const ms = {
  ocrLanguage: 'Bahasa pengecaman',
  ocrLanguageDefault: 'Lalai sistem',
  ocrLanguageUnavailable:
    'Bahasa yang dipilih tidak tersedia. Pilih bahasa lain atau pasang bahasa ini pada peranti.',
  ocrTitle: 'Jalankan OCR',
  ocrBatch: 'Mulakan OCR kelompok',
  ocrPdf: 'PDF boleh dicari',
  ocrWord: 'Word boleh disunting',
  ocrRunning: 'Mengenal pasti teks…',
  ocrNoText: 'Tiada teks yang boleh dibaca ditemui.',
  ocrUnavailable: 'OCR setempat tidak tersedia pada peranti ini.',
  title: 'Penukaran fail',
  chooseFiles: 'Pilih fail',
  outputFormat: 'Format output',
  convert: 'Tukar',
  converting: 'Sedang menukar…',
  destinationHint:
    'Setiap fail yang ditukar disimpan dalam folder fail asalnya. Jika nama itu sudah digunakan, nombor ditambah pada nama fail baharu.',
  noCommonFormat:
    'Tiada format output yang sesuai untuk semua fail ini. Alih keluar beberapa fail daripada senarai atau pilih fail lain.',
  chooseFailed: 'Tetingkap pemilihan fail tidak dapat dibuka.',
  convertFailed: 'Penukaran fail tidak dapat diselesaikan.',
  saved: 'Disimpan',
  failed: 'Penukaran gagal',
  removeFile: 'Alih keluar {name} daripada senarai',
  ocrRange: 'Halaman untuk dikenali',
  ocrAllPages: 'Semua halaman',
  ocrRangeInvalid: 'Semak julat halaman fail ini. Contoh: 1, 3–5',
} satisfies Record<keyof typeof zh, string>
