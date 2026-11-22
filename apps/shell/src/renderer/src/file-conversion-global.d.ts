import type { FileConversionApi, OcrFilesApi } from '../../shared/file-conversion'

declare global {
  interface Window {
    ocrFilesApi: OcrFilesApi
    fileConversionApi: FileConversionApi
  }
}
