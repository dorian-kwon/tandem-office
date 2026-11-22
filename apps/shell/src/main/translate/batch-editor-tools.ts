import { randomUUID } from 'node:crypto'
import type { IpcMainEvent, WebContents } from 'electron'
import type { AgentToolCall, AgentToolDef, ToolExecution } from '@genoffice/agent-core'
import {
  EDITOR_TOOL_REQUEST,
  EDITOR_TOOL_REPLY,
  type BatchTranslationChoices,
  type EditorToolReply,
  type EditorToolRequest,
} from '@genoffice/project-store/editor-run'

export interface BatchEditorTools {
  tools: AgentToolDef[]
  systemPrompt: string
  executeTool(call: AgentToolCall, signal?: AbortSignal): Promise<ToolExecution>
  close(): void
}

/** A request can only address the main frame of the originally opened editor.
 * Probe until its AI panel is mounted; execution requests are never replayed. */
export async function openBatchEditorTools(
  wc: WebContents,
  path: string,
  signal: AbortSignal,
  choices?: BatchTranslationChoices,
): Promise<BatchEditorTools> {
  signal.throwIfAborted()
  if (wc.isDestroyed()) throw new Error('The document editor is closed.')
  const session = randomUUID()
  let closed = false
  let pending:
    | { id: string; resolve: (reply: EditorToolReply) => void; reject: (err: Error) => void }
    | undefined
  const send = (request: EditorToolRequest) => wc.send(EDITOR_TOOL_REQUEST, request)
  const reply = (event: IpcMainEvent, value: EditorToolReply) => {
    if (
      event.senderFrame !== wc.mainFrame ||
      !pending ||
      value?.session !== session ||
      value.id !== pending.id
    )
      return
    if (value.kind === 'error') pending.reject(new Error(value.error))
    else pending.resolve(value)
  }
  const close = () => {
    if (closed) return
    closed = true
    if (!wc.isDestroyed()) {
      send({ kind: 'close', path, session, id: session })
      wc.ipc.removeListener(EDITOR_TOOL_REPLY, reply)
    }
    wc.removeListener('destroyed', close)
    wc.removeListener('render-process-gone', close)
    wc.removeListener('did-start-navigation', navigated)
    signal.removeEventListener('abort', aborted)
    pending?.reject(new Error('The document tool session closed.'))
  }
  let ready = false
  const navigated = (event: { isMainFrame: boolean; isSameDocument: boolean }) => {
    if (ready && event.isMainFrame && !event.isSameDocument) close()
  }
  const aborted = () => {
    if (ready && pending && !wc.isDestroyed())
      send({ kind: 'cancel', id: pending.id, path, session })
    else close()
  }
  wc.ipc.on(EDITOR_TOOL_REPLY, reply)
  wc.once('destroyed', close)
  wc.once('render-process-gone', close)
  wc.on('did-start-navigation', navigated)
  signal.addEventListener('abort', aborted, { once: true })

  async function request(message: EditorToolRequest, callSignal?: AbortSignal) {
    signal.throwIfAborted()
    callSignal?.throwIfAborted()
    if (closed || pending) throw new Error('The document tools are closed or busy.')
    let retry: ReturnType<typeof setInterval> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    let cancelDeadline: ReturnType<typeof setTimeout> | undefined
    const cancel = () => {
      if (!wc.isDestroyed()) send({ kind: 'cancel', id: message.id, path, session })
      cancelDeadline = setTimeout(close, 30_000)
    }
    try {
      const result = await new Promise<EditorToolReply>((resolve, reject) => {
        pending = { id: message.id, resolve, reject }
        callSignal?.addEventListener('abort', cancel, { once: true })
        if (message.kind === 'describe')
          retry = setInterval(() => {
            if (!wc.isDestroyed()) send(message)
          }, 300)
        deadline = setTimeout(() => {
          reject(new Error('Timed out waiting for the document editor.'))
          close()
        }, 120_000)
        send(message)
      })
      signal.throwIfAborted()
      callSignal?.throwIfAborted()
      return result
    } finally {
      pending = undefined
      clearInterval(retry)
      clearTimeout(deadline)
      clearTimeout(cancelDeadline)
      callSignal?.removeEventListener('abort', cancel)
    }
  }
  try {
    const result = await request({
      kind: 'describe',
      id: session,
      path,
      session,
      ...(choices && { choices }),
    })
    if (result.kind !== 'described') throw new Error('Invalid document tool handshake.')
    ready = true
    return {
      tools: result.tools,
      systemPrompt: result.systemPrompt,
      close,
      async executeTool(call, callSignal) {
        const response = await request(
          { kind: 'execute', id: randomUUID(), path, session, call },
          callSignal,
        )
        if (response.kind !== 'result') throw new Error('Invalid document tool response.')
        return response.execution
      },
    }
  } catch (error) {
    close()
    throw error
  }
}
