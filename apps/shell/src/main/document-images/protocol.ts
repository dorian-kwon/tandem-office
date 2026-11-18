export type ImageDocumentKind = 'hwp' | 'hwpx' | 'docx' | 'xlsx' | 'pptx'
export const MAX_SOURCE_BYTES = 2 * 1024 ** 3
export const PROMPT_BMP_BYTES = 20 * 1024 ** 2
export interface ImageJob {
  type: 'run'
  mode: 'inspect' | 'convert'
  input: string
  kind: ImageDocumentKind
  directory: string
  identity?: string
}
export interface ImageJobSummary {
  identity: string
  count: number
  bmpBytes: number
}
export interface ImageJobConversion {
  converted: number
  skipped: number
}
export type ImageJobResult = ImageJobSummary | ImageJobConversion
export type ImageChildMessage =
  | { type: 'result'; value: ImageJobResult | null }
  | { type: 'error' }
  | { type: 'progress'; done: number; total: number }
  | { type: 'encode'; id: number; width: number; height: number }
export function fileIdentity(stat: {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
}): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')
}
export function imageDocumentKind(path: string): ImageDocumentKind | null {
  return (
    (/\.(hwp|hwpx|docx|xlsx|pptx)$/i.exec(path)?.[1]?.toLowerCase() as ImageDocumentKind) ?? null
  )
}
