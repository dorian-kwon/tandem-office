// One turn in a document editor, requested by the project window. Only main
// sends commands. Replies are bound to both the request id and its webContents.
export const EDITOR_REQUEST = 'translation-project:editor-request'
export const EDITOR_REPLY = 'translation-project:editor-reply'

export type BatchConversation = { prompt: string; reply?: string; file?: string }[]

export interface BatchTranslationChoices {
  outputMode?: string
  bilingual?: string
}

export type EditorRequest =
  | { kind: 'probe'; id: string; path: string }
  | {
      kind: 'start'
      id: string
      path: string
      prompt: string
      batchChoices?: BatchTranslationChoices
      batchConversation?: BatchConversation
    }
  | { kind: 'stop'; id: string }

export type EditorReply =
  | { kind: 'ready' | 'started'; id: string }
  | { kind: 'progress'; id: string; operations: number; done?: number; total?: number }
  | { kind: 'error'; id: string; error: string }
  | {
      kind: 'done'
      id: string
      text: string
      mutated: boolean
      inspected: boolean
      incomplete: boolean
    }

export interface ProjectEditorBridge {
  onEditorRequest(listener: (message: EditorRequest) => void): () => void
  replyToEditorRequest(reply: EditorReply): void
}

/** Private main ↔ main-frame RPC. Tool calls have no provider credentials or transport. */
export const EDITOR_TOOL_REQUEST = 'translation-project:editor-tool-request'
export const EDITOR_TOOL_REPLY = 'translation-project:editor-tool-reply'

import type { AgentToolCall, AgentToolDef, ToolExecution } from '@genoffice/agent-core'

interface ToolRequestBase {
  id: string
  session: string
  path: string
}
export type EditorToolRequest = ToolRequestBase &
  (
    | { kind: 'describe'; choices?: BatchTranslationChoices }
    | { kind: 'execute'; call: AgentToolCall }
    | { kind: 'cancel' | 'close' }
  )
export type EditorToolReply =
  | { id: string; session: string; kind: 'described'; tools: AgentToolDef[]; systemPrompt: string }
  | { id: string; session: string; kind: 'result'; execution: ToolExecution }
  | { id: string; session: string; kind: 'error'; error: string }

export interface ProjectEditorToolBridge {
  onEditorToolRequest(listener: (request: EditorToolRequest) => void): () => void
  replyToEditorToolRequest(reply: EditorToolReply): void
}
