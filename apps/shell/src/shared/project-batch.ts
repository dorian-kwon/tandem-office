export type ProjectBatchItemState = 'waiting' | 'running' | 'saved' | 'failed' | 'stopped'
export interface ProjectBatchActivity {
  phase?: 'opening' | 'ocr' | 'translating' | 'saving'
  /** The editor checked this output for remaining source text after the last edit. */
  verified?: boolean
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
  id?: string
  messages?: ProjectBatchMessage[]
  dir: string
  running: boolean
  stopping: boolean
  items: ProjectBatchItem[]
}
export interface ProjectBatchStart {
  useWiki?: boolean
  dir: string
  files?: string[]
  retry?: boolean
  rerunBatchId?: string
}

export interface ProjectBatchSend {
  useWiki?: boolean
  dir: string
  batchId: string
  prompt: string
  files: string[]
}
export interface ProjectBatchMessage {
  id: string
  prompt: string
  reply?: string
  partialReply?: string
  targets: {
    file: string
    state: 'queued' | 'running' | 'done' | 'failed' | 'stopped'
    reply?: string
    error?: string
  }[]
}
