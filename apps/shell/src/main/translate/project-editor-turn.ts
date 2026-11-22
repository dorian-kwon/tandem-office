import { randomUUID } from 'node:crypto'
import type { IpcMainEvent, WebContents } from 'electron'
import {
  EDITOR_REPLY,
  EDITOR_REQUEST,
  type BatchTranslationChoices,
  type BatchConversation,
  type EditorReply,
  type EditorRequest,
} from '@genoffice/project-store/editor-run'

/** Wait until this particular editor has opened the output, admitted the
 * request, finished its AI loop, and settled its edit history. */
export function projectEditorTurn(
  wc: WebContents,
  path: string,
  prompt: string,
  signal: AbortSignal,
  onProgress?: (event: Extract<EditorReply, { kind: 'progress' }>) => void,
  batchChoices?: BatchTranslationChoices,
  batchConversation?: BatchConversation,
): Promise<Extract<EditorReply, { kind: 'done' }>> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const id = randomUUID()
    let started = false
    let stopping: ReturnType<typeof setTimeout> | undefined
    const send = (command: EditorRequest) => wc.send(EDITOR_REQUEST, command)
    const lost = () => fail('The document editor closed during the request.')
    const navigated = (event: { isMainFrame: boolean; isSameDocument: boolean }) => {
      if (started && event.isMainFrame && !event.isSameDocument) lost()
    }
    const stop = () => {
      if (!started || wc.isDestroyed()) return fail('The project request was stopped.')
      send({ kind: 'stop', id })
      // Keep the document reserved while the editor settles tool calls already in flight.
      stopping = setTimeout(
        () => fail('The document editor did not acknowledge the stop request.'),
        30_000,
      )
    }
    const probe = () => {
      if (!started && !wc.isDestroyed()) send({ kind: 'probe', id, path })
    }
    const timer = setInterval(probe, 300)
    const deadline = setTimeout(
      () => fail('The document or its AI connection did not become ready.'),
      120_000,
    )
    function clean() {
      clearTimeout(stopping)
      clearTimeout(deadline)
      clearInterval(timer)
      wc.ipc.removeListener(EDITOR_REPLY, reply)
      wc.removeListener('destroyed', lost)
      wc.removeListener('render-process-gone', lost)
      wc.removeListener('did-start-navigation', navigated)
      signal.removeEventListener('abort', stop)
    }
    function fail(reason: string) {
      clean()
      reject(new Error(reason))
    }
    function reply(event: IpcMainEvent, message: EditorReply) {
      if (event.senderFrame !== wc.mainFrame || !message || message.id !== id) return
      if (message.kind === 'ready' && !started) {
        started = true
        clearInterval(timer)
        send({
          kind: 'start',
          id,
          path,
          prompt,
          ...(batchChoices ? { batchChoices } : {}),
          ...(batchConversation ? { batchConversation } : {}),
        })
      } else if (started && message.kind === 'started') {
        clearTimeout(deadline)
      } else if (started && !signal.aborted && message.kind === 'progress') {
        onProgress?.(message)
      } else if (message.kind === 'error') {
        fail(message.error)
      } else if (started && message.kind === 'done') {
        clean()
        if (signal.aborted) reject(new Error('The project request was stopped.'))
        else resolve(message)
      }
    }
    wc.ipc.on(EDITOR_REPLY, reply)
    wc.once('destroyed', lost)
    wc.once('render-process-gone', lost)
    wc.on('did-start-navigation', navigated)
    signal.addEventListener('abort', stop, { once: true })
    probe()
  })
}
