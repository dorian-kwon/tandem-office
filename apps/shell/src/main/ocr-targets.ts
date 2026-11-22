import { extname } from 'node:path'

import { ROUTED_EXTENSIONS } from './app-routing'

export const OCR_EXTENSIONS: string[] = [
  ...Object.values(ROUTED_EXTENSIONS).flat(),
  'png',
  'jpg',
  'jpeg',
]
export const ocrTargets = (path: string): string[] =>
  OCR_EXTENSIONS.includes(extname(path).slice(1).toLowerCase()) ? ['pdf', 'docx'] : []
