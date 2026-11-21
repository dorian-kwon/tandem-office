import type { zh } from './zh'

export const id = {
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
} satisfies Record<keyof typeof zh, string>
