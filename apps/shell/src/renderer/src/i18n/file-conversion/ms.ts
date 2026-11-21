import type { zh } from './zh'

export const ms = {
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
} satisfies Record<keyof typeof zh, string>
