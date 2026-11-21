export type ProjectBatchItemState = 'waiting' | 'running' | 'saved' | 'failed' | 'stopped'
export interface ProjectBatchActivity {
  phase?: 'opening' | 'ocr' | 'translating' | 'saving'
  operations?: number
  done?: number
  total?: number
}
export interface ProjectBatchItem extends ProjectBatchActivity {
  file: string
  state: ProjectBatchItemState
  output?: string
  error?: string
}
export interface ProjectBatchSnapshot {
  dir: string
  running: boolean
  stopping: boolean
  items: ProjectBatchItem[]
}
export interface ProjectBatchStart {
  dir: string
  files?: string[]
  retry?: boolean
}
