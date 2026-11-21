import type { zh } from './zh'

export const ja = {
  title: 'ファイル変換',
  chooseFiles: 'ファイルを選択',
  outputFormat: '出力形式',
  convert: '変換',
  converting: '変換中…',
  destinationHint:
    '変換したファイルは元のファイルと同じフォルダーに保存されます。同名のファイルがある場合は、新しいファイル名に番号が付きます。',
  noCommonFormat:
    '選んだファイルに共通の出力形式がありません。一部のファイルを一覧から外すか、別のファイルを選んでください。',
  chooseFailed: 'ファイル選択画面を開けませんでした。',
  convertFailed: 'ファイルの変換を完了できませんでした。',
  saved: '保存済み',
  failed: '変換失敗',
  removeFile: '{name} を一覧から外す',
} satisfies Record<keyof typeof zh, string>
