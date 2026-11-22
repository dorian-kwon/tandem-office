import type { zh } from './zh'

export const ja = {
  ocrLanguage: '認識言語',
  ocrLanguageDefault: 'システムの既定値',
  ocrLanguageUnavailable:
    '選択した認識言語を使用できません。他の言語を選ぶか、この端末に言語をインストールしてください。',
  ocrTitle: 'OCR を実行',
  ocrBatch: '一括OCRを開始',
  ocrPdf: '検索可能な PDF',
  ocrWord: '編集可能な Word',
  ocrRunning: '文字認識中…',
  ocrNoText: '認識できる文字が見つかりません。',
  ocrUnavailable: 'このデバイスではローカル OCR を利用できません。',
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
  ocrRange: '認識するページ',
  ocrAllPages: 'すべてのページ',
  ocrRangeInvalid: 'このファイルのページ範囲を確認してください。例：1, 3–5',
} satisfies Record<keyof typeof zh, string>
