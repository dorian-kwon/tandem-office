import { acquireEditorAiWork, useEditorAiBusy } from './editor-ai-busy'
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import type { AgentLoopEvents, AgentToolCall } from '@genoffice/agent-core'
import { IDLE_RUN_STATUS, reduceRunStatus, type RunStatusState } from './ai-run-status'

/** How long "Finished" / "Stopped" stay on the line. Waiting and error stay until the next run. */
export const RUN_STATUS_DONE_MS = 4000
export const RUN_STATUS_STOPPED_MS = 5000

export interface AiRunStatusController {
  readonly state: RunStatusState
  /** Returns the same loop events with the status updates added in front of the panel's own handlers. */
  wrap<S>(events: AgentLoopEvents<S>): AgentLoopEvents<S>
  /** The person answered the popup the AI was waiting on (call from the popup's close). */
  resolveWaiting(): void
}

/**
 * One status line state for a panel, driven by the run loop's own events.
 * `busy` is the panel's existing flag; it marks the start of a run (a queued
 * message starting right after the last one included) and clears a state left
 * behind by a reset. Everything else comes from the loop through `wrap`.
 */
export function useAiRunStatus(busy: boolean): AiRunStatusController {
  const [state, dispatch] = useReducer(reduceRunStatus, IDLE_RUN_STATUS)
  useEditorAiBusy(busy || state.awaiting || !state.ended)

  useEffect(() => {
    dispatch(busy ? { type: 'begin', at: Date.now() } : { type: 'idle' })
  }, [busy])

  useEffect(() => {
    if (state.phase !== 'done' && state.phase !== 'stopped') return
    const timer = setTimeout(
      () => dispatch({ type: 'dismiss' }),
      state.phase === 'done' ? RUN_STATUS_DONE_MS : RUN_STATUS_STOPPED_MS,
    )
    return () => clearTimeout(timer)
  }, [state.phase])

  // dispatch is stable, so the wrapped events stay valid inside a loop created once
  const dispatchRef = useRef(dispatch)
  // Call object identity distinguishes overlapping runs even if model call IDs repeat.
  // Do not release on reset/unmount: an aborted tool may still be writing.
  const toolWork = useRef(new WeakMap<AgentToolCall, () => void>())
  const wrap = useCallback(
    <S>(events: AgentLoopEvents<S>): AgentLoopEvents<S> => ({
      ...events,
      onText: (text) => {
        dispatchRef.current({ type: 'text' })
        events.onText?.(text)
      },
      onToolStart: (call) => {
        dispatchRef.current({ type: 'tool-start', name: call.name })
        events.onToolStart?.(call)
      },
      onToolPending: (call, pending) => {
        if (pending) {
          if (!toolWork.current.has(call)) toolWork.current.set(call, acquireEditorAiWork())
        } else {
          toolWork.current.get(call)?.()
          toolWork.current.delete(call)
        }
        events.onToolPending?.(call, pending)
      },
      onToolExecuted: (event) => {
        dispatchRef.current({
          type: 'tool-done',
          awaitingUser: event.execution.awaitingUser === true,
          note: event.execution.runNote,
          at: Date.now(),
        })
        events.onToolExecuted?.(event)
      },
      onDone: (result) => {
        dispatchRef.current({ type: 'done', cancelled: result.cancelled })
        events.onDone?.(result)
      },
      onError: (error) => {
        dispatchRef.current({ type: 'error' })
        events.onError?.(error)
      },
    }),
    [],
  )
  const resolveWaiting = useCallback(() => dispatchRef.current({ type: 'resolve-waiting' }), [])
  return useMemo(() => ({ state, wrap, resolveWaiting }), [state, wrap, resolveWaiting])
}
