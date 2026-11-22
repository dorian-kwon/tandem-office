import type {
  AgentStreamCallbacks,
  AgentStreamRequest,
  AgentTokenUsage,
  AgentToolCall,
} from '@genoffice/agent-core'

export const BATCH_MODEL_REQUEST = 'translate:batch-model-request'
export const BATCH_MODEL_EVENT = 'translate:batch-model-event'

export type BatchModelCommand =
  | { kind: 'start'; session: string; turn: string; request: AgentStreamRequest }
  | { kind: 'cancel'; session: string; turn: string }
  | { kind: 'close'; session: string }

type Payload =
  | { kind: 'started' | 'done' }
  | { kind: 'delta' | 'reasoning' | 'error' | 'stop-reason'; text: string }
  | { kind: 'tool-call'; call: AgentToolCall }
  | { kind: 'phase'; phase: Parameters<NonNullable<AgentStreamCallbacks['onPhase']>>[0] }
  | { kind: 'usage'; usage: AgentTokenUsage }

export type BatchModelEvent = { session: string; turn: string } & Payload
export type BatchModelPayload = Payload
export interface BatchModelRelay {
  onCommand(fn: (command: BatchModelCommand) => void): () => void
  report(event: BatchModelEvent): void
}

declare global {
  interface Window {
    aiOfficeBatchModel: BatchModelRelay
  }
}
