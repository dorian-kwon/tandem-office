import { extname } from 'node:path'

export const OCR_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg']
export const ocrTargets = (path: string): string[] =>
  OCR_EXTENSIONS.includes(extname(path).slice(1).toLowerCase()) ? ['pdf', 'docx'] : []
