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
