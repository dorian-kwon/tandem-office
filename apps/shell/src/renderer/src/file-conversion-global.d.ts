import type { FileConversionApi } from '../../shared/file-conversion'

declare global {
  interface Window {
    fileConversionApi: FileConversionApi
  }
}
