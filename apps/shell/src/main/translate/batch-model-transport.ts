import { randomUUID } from 'node:crypto'
import type { IpcMainEvent, WebContents } from 'electron'
import type { AgentStreamCallbacks, AgentTransport } from '@genoffice/agent-core'
import {
  BATCH_MODEL_EVENT,
  BATCH_MODEL_REQUEST,
  type BatchModelCommand,
  type BatchModelEvent,
} from '../../shared/batch-model-relay'

/** The shell renderer owns provider settings, consent UI and the standard ai:stream bridge.
 * Each loop has its own route/session. Only the initiating shell's main frame can reply.
 */
export function createBatchModelTransport(
  wc: WebContents,
  signal: AbortSignal,
): AgentTransport & { dispose(): void } {
  const session = randomUUID()
  const ipc = wc.isDestroyed() ? undefined : wc.ipc
  const turns = new Map<string, { cb: AgentStreamCallbacks; ack: ReturnType<typeof setTimeout> }>()
  let closed = false
  const send = (command: BatchModelCommand) => {
    if (wc.isDestroyed()) return false
    try {
      wc.send(BATCH_MODEL_REQUEST, command)
      return true
    } catch {
      // Electron can discard the frame between isDestroyed and send.
      return false
    }
  }
  function finish(turn: string) {
    const active = turns.get(turn)
    if (active) clearTimeout(active.ack)
    turns.delete(turn)
    return active?.cb
  }
  function receive(e: IpcMainEvent, event: BatchModelEvent) {
    if (e.senderFrame !== wc.mainFrame || !event || event.session !== session) return
    const active = turns.get(event.turn)
    if (!active) return
    clearTimeout(active.ack)
    const cb = active.cb
    switch (event.kind) {
      case 'started':
        break
      case 'delta':
        cb.onDelta(event.text)
        break
      case 'reasoning':
        cb.onReasoning?.(event.text)
        break
      case 'tool-call':
        cb.onToolCall(event.call)
        break
      case 'usage':
        cb.onUsage?.(event.usage)
        break
      case 'phase':
        cb.onPhase?.(event.phase)
        break
      case 'stop-reason':
        cb.onStopReason?.(event.text)
        break
      case 'error':
        finish(event.turn)?.onError(event.text)
        break
      case 'done':
        finish(event.turn)?.onDone()
        break
    }
  }
  function close(reason?: string) {
    if (closed) return
    closed = true
    signal.removeEventListener('abort', dispose)
    wc.removeListener('destroyed', lost)
    wc.removeListener('render-process-gone', lost)
    wc.removeListener('did-start-navigation', navigated)
    ipc?.removeListener(BATCH_MODEL_EVENT, receive)
    send({ kind: 'close', session })
    for (const turn of turns.keys()) {
      const cb = finish(turn)!
      if (reason) cb.onError(reason)
      else cb.onDone()
    }
  }
  function dispose() {
    close()
  }
  function lost() {
    close('The window running batch chat closed.')
  }
  function navigated(event: { isMainFrame: boolean; isSameDocument: boolean }) {
    if (event.isMainFrame && !event.isSameDocument) lost()
  }
  if (signal.aborted || !ipc) closed = true
  else {
    signal.addEventListener('abort', dispose, { once: true })
    ipc.on(BATCH_MODEL_EVENT, receive)
    wc.once('destroyed', lost)
    wc.once('render-process-gone', lost)
    wc.on('did-start-navigation', navigated)
  }
  return {
    dispose,
    stream(request, cb) {
      if (closed) {
        cb.onError('The batch chat session has closed.')
        return { cancel() {} }
      }
      const turn = randomUUID()
      const cancel = () => {
        const active = finish(turn)
        if (!active) return
        send({ kind: 'cancel', session, turn })
        active.onDone()
      }
      const ack = setTimeout(() => {
        const active = finish(turn)
        if (!active) return
        send({ kind: 'cancel', session, turn })
        active.onError('The batch chat window did not respond.')
      }, 30_000)
      turns.set(turn, { cb, ack })
      if (!send({ kind: 'start', session, turn, request }))
        finish(turn)?.onError('The batch chat window is unavailable.')
      return { cancel }
    },
  }
}
