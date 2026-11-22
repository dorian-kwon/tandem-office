export const OCR_CHANNELS = {
  pick: 'ocr-files:pick',
  drop: 'ocr-files:drop',
  languages: 'ocr-files:languages',
  run: 'ocr-files:run',
  progress: 'ocr-files:progress',
} as const

export const FILE_CONVERSION_CHANNELS = {
  pick: 'file-conversion:pick',
  run: 'file-conversion:run',
  progress: 'file-conversion:progress',
} as const

export interface FileConversionInput {
  id: string
  name: string
  displayPath: string
  targets: string[]
}

export interface FileConversionResult {
  id: string
  outputPath?: string
  warning?: string
  error?: string
}

export interface FileConversionApi {
  pick(): Promise<FileConversionInput[]>
  run(ids: string[], target: string): Promise<FileConversionResult[]>
  onProgress(listener: (result: FileConversionResult) => void): () => void
}

export interface OcrFileOptions {
  language?: string
  pageRange?: string
}

export interface OcrFilesApi extends FileConversionApi {
  drop(files: File[]): Promise<FileConversionInput[]>
  languages(): Promise<string[]>
  run(ids: string[], target: string, options?: OcrFileOptions): Promise<FileConversionResult[]>
}
