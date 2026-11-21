import type { zh } from './zh'

export const zhTW = {
  title: '檔案轉換',
  chooseFiles: '選取檔案',
  outputFormat: '輸出格式',
  convert: '轉換',
  converting: '轉換中…',
  destinationHint: '轉換後的檔案會存放在各自原始檔案的資料夾中。若有同名檔案，會在新檔名加上編號。',
  noCommonFormat: '所選檔案沒有共通的輸出格式。請從清單中移除部分檔案，或選取其他檔案。',
  chooseFailed: '無法開啟檔案選擇視窗。',
  convertFailed: '無法完成檔案轉換。',
  saved: '已儲存',
  failed: '轉換失敗',
  removeFile: '從清單中移除 {name}',
} satisfies Record<keyof typeof zh, string>
