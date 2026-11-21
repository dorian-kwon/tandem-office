// One turn in a document editor, requested by the project window. Only main
// sends commands. Replies are bound to both the request id and its webContents.
export const EDITOR_REQUEST = 'translation-project:editor-request'
export const EDITOR_REPLY = 'translation-project:editor-reply'

export type EditorRequest =
  | { kind: 'probe'; id: string; path: string }
  | { kind: 'start'; id: string; path: string; prompt: string }
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
