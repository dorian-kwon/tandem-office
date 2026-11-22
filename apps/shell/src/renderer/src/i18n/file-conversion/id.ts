import type { zh } from './zh'

export const id = {
  ocrLanguage: 'Bahasa pengenalan',
  ocrLanguageDefault: 'Bawaan sistem',
  ocrLanguageUnavailable:
    'Bahasa yang dipilih tidak tersedia. Pilih bahasa lain atau instal bahasa ini di perangkat.',
  ocrTitle: 'Jalankan OCR',
  ocrBatch: 'Jalankan OCR massal',
  ocrPdf: 'PDF yang dapat dicari',
  ocrWord: 'Word yang dapat diedit',
  ocrRunning: 'Mengenali teks…',
  ocrNoText: 'Tidak ditemukan teks yang terbaca.',
  ocrUnavailable: 'OCR lokal tidak tersedia pada perangkat ini.',
  title: 'Konversi berkas',
  chooseFiles: 'Pilih berkas',
  outputFormat: 'Format keluaran',
  convert: 'Konversi',
  converting: 'Mengonversi…',
  destinationHint:
    'Setiap berkas hasil konversi disimpan di folder berkas aslinya. Jika namanya sudah digunakan, nomor ditambahkan ke nama berkas baru.',
  noCommonFormat:
    'Tidak ada format keluaran yang cocok untuk semua berkas ini. Hapus beberapa berkas dari daftar atau pilih berkas lain.',
  chooseFailed: 'Tidak dapat membuka jendela pemilihan berkas.',
  convertFailed: 'Konversi berkas tidak dapat diselesaikan.',
  saved: 'Tersimpan',
  failed: 'Konversi gagal',
  removeFile: 'Hapus {name} dari daftar',
  ocrRange: 'Halaman yang dikenali',
  ocrAllPages: 'Semua halaman',
  ocrRangeInvalid: 'Periksa rentang halaman berkas ini. Contoh: 1, 3–5',
} satisfies Record<keyof typeof zh, string>
