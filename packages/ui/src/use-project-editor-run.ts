import { useProjectEditorTools } from './use-project-editor-tools'
import { beginBatchConversation, endBatchConversation } from './project-batch-conversation'
import { useEffect, useRef, type RefObject } from 'react'
import type { AgentRunResult } from '@genoffice/agent-core'
import type {
  BatchTranslationChoices,
  EditorReply,
  ProjectEditorBridge,
} from '@genoffice/project-store/editor-run'

export interface ProjectTurn {
  batchFollowup?: boolean
  batchChoices?: BatchTranslationChoices
  id: string
  mutated: boolean
  inspected: boolean
  operations: number
  progress?: { done: number; total: number } | undefined
  notifyProgress: (progress: Extract<EditorReply, { kind: 'progress' }>) => void
  stopRequested?: boolean
  result?: EditorReply
  observedBusy: boolean
}

export function finishProjectTurn(turn: ProjectTurn | null, result: AgentRunResult): void {
  if (!turn || turn.result) return
  turn.result = result.cancelled
    ? { kind: 'error', id: turn.id, error: 'The document AI stopped before finishing its request.' }
    : {
        kind: 'done',
        id: turn.id,
        text: result.text,
        mutated: turn.mutated,
        inspected: turn.inspected,
        incomplete: Boolean(result.turnLimit || result.truncated),
      }
}

export function useProjectEditorRun(options: {
  documentEditor?: NonNullable<Parameters<typeof useProjectEditorTools>[0]['documentEditor']>
  documentLoop?: NonNullable<Parameters<typeof useProjectEditorTools>[0]['documentLoop']>
  turn: RefObject<ProjectTurn | null>
  path: string | undefined | null
  ready: boolean
  gate: () => { kind: string }
  busy: boolean
  send: (prompt: string) => unknown
  stop: () => void
}): void {
  useProjectEditorTools(options)
  const ref = useRef(options)
  ref.current = options
  useEffect(() => {
    const api = (globalThis as { projectFolderApi?: ProjectEditorBridge }).projectFolderApi
    if (!api?.onEditorRequest) return
    const off = api.onEditorRequest((message) => {
      const { turn, path, ready, gate, busy, send, stop } = ref.current
      if (message.kind === 'stop') {
        if (turn.current?.id === message.id) {
          turn.current.stopRequested = true
          stop()
        }
        return
      }
      const error = (reason: string) =>
        api.replyToEditorRequest({ kind: 'error', id: message.id, error: reason })
      if (!ready || !path || path !== message.path || gate().kind === 'checking') return
      if (turn.current || busy) return error('The document AI is already busy.')
      if (gate().kind !== 'run')
        return error('Check the AI connection and first-use notice in the app.')
      if (message.kind === 'probe') {
        api.replyToEditorRequest({ kind: 'ready', id: message.id })
        return
      }
      turn.current = {
        ...(message.batchConversation ? { batchFollowup: true } : {}),
        ...(message.batchChoices ? { batchChoices: message.batchChoices } : {}),
        id: message.id,
        mutated: false,
        inspected: false,
        operations: 0,
        observedBusy: false,
        notifyProgress: (progress) => api.replyToEditorRequest(progress),
      }
      beginBatchConversation(message.id, message.batchConversation)
      try {
        if (send(message.prompt) === false)
          throw new Error('The document editor could not start this request.')
      } catch (cause) {
        endBatchConversation(message.id)
        turn.current = null
        error(String(cause))
      }
    })
    return () => {
      off()
      const turn = ref.current.turn
      if (turn.current) endBatchConversation(turn.current.id)
      if (turn.current)
        api.replyToEditorRequest({
          kind: 'error',
          id: turn.current.id,
          error: 'The editor was closed.',
        })
      turn.current = null
    }
  }, [])
  // Some editors finish a history transaction after onDone. Wait for the
  // panel to release its busy flag before allowing main to write the file.
  useEffect(() => {
    const turn = options.turn.current
    if (!turn) return
    if (options.busy) {
      if (!turn.observedBusy) {
        const api = (globalThis as { projectFolderApi?: ProjectEditorBridge }).projectFolderApi
        api?.replyToEditorRequest({ kind: 'started', id: turn.id })
        turn.observedBusy = true
        if (turn.stopRequested) options.stop()
      }
      return
    }
    if (!turn.result && !turn.observedBusy) return
    const api = (globalThis as { projectFolderApi?: ProjectEditorBridge }).projectFolderApi
    api?.replyToEditorRequest(
      turn.result ?? {
        kind: 'error',
        id: turn.id,
        error: 'The document AI did not finish the request.',
      },
    )
    endBatchConversation(turn.id)
    options.turn.current = null
  })
}
