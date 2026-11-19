import type { Lang } from '@genoffice/i18n'
import { AI_RUN_STATUS_STRINGS } from './strings-ai-run-status'

/**
 * Persistent run status of the AI panel: running / waiting for the person /
 * done / stopped / error. It is fed by the real run loop events (see
 * `useAiRunStatus`), never by the text of the messages.
 *
 * `waiting` is entered when a tool reports `awaitingUser` (it opened a popup the
 * AI itself asked for). It outlives the run: the model ends its turn, but the
 * line keeps saying the person is needed until `resolve-waiting` or a new run.
 */
export type RunStatusPhase = 'idle' | 'running' | 'waiting' | 'done' | 'stopped' | 'error'

export interface RunStatusState {
  readonly phase: RunStatusPhase
  /** ms epoch the run began */
  readonly startedAt: number
  /** ms epoch the current wait began (waiting only) */
  readonly since: number
  /** the tool that is running right now */
  readonly tool?: string | undefined
  /** the reply text is streaming */
  readonly writing: boolean
  /** a tool asked the person to act and nobody answered yet */
  readonly awaiting: boolean
  /** the loop reported its end (done / stopped / error) */
  readonly ended: boolean
  /** one-line remaining summary a tool supplied ("Nothing is left") */
  readonly note?: string | undefined
}

export const IDLE_RUN_STATUS: RunStatusState = {
  phase: 'idle',
  startedAt: 0,
  since: 0,
  writing: false,
  awaiting: false,
  ended: true,
}

export type RunStatusAction =
  | { type: 'begin'; at: number }
  | { type: 'tool-start'; name: string }
  | {
      type: 'tool-done'
      awaitingUser?: boolean | undefined
      note?: string | undefined
      at?: number
    }
  | { type: 'text' }
  | { type: 'done'; cancelled: boolean }
  | { type: 'error' }
  /** the person answered the popup the AI waited on */
  | { type: 'resolve-waiting' }
  /** the busy flag dropped with no terminal event (reset, chat switch) */
  | { type: 'idle' }
  /** auto-dismiss of done / stopped */
  | { type: 'dismiss' }

const inRun = (s: RunStatusState): boolean => s.phase === 'running' || s.phase === 'waiting'

export function reduceRunStatus(s: RunStatusState, a: RunStatusAction): RunStatusState {
  switch (a.type) {
    case 'begin':
      // a duplicate begin (busy flag and first event racing) must not reset the clock
      if (inRun(s) && !s.ended) return s
      return { ...IDLE_RUN_STATUS, phase: 'running', startedAt: a.at, ended: false }
    case 'tool-start':
      if (!inRun(s) || s.ended) return s
      // a tool starting after a wait means the person answered
      return { ...s, phase: 'running', tool: a.name, writing: false, awaiting: false }
    case 'tool-done': {
      if (!inRun(s) || s.ended) return s
      const note = a.note ?? s.note
      const next = { ...s, tool: undefined, note }
      if (a.awaitingUser) return { ...next, phase: 'waiting', awaiting: true, since: a.at ?? 0 }
      return next
    }
    case 'text':
      if (s.phase !== 'running' || s.writing) return s
      return { ...s, writing: true, tool: undefined }
    case 'done':
      if (!inRun(s)) return s
      if (a.cancelled)
        return { ...s, phase: 'stopped', awaiting: false, ended: true, tool: undefined }
      if (s.awaiting)
        return { ...s, phase: 'waiting', ended: true, tool: undefined, writing: false }
      return { ...s, phase: 'done', ended: true, tool: undefined, writing: false }
    case 'error':
      if (!inRun(s)) return s
      return { ...s, phase: 'error', awaiting: false, ended: true, tool: undefined }
    case 'resolve-waiting':
      if (s.phase !== 'waiting') return s
      return s.ended ? IDLE_RUN_STATUS : { ...s, phase: 'running', awaiting: false }
    case 'idle':
      return inRun(s) && !s.awaiting ? IDLE_RUN_STATUS : s
    case 'dismiss':
      return s.phase === 'done' || s.phase === 'stopped' ? IDLE_RUN_STATUS : s
  }
}

/** Readable tool name from its identifier: translate_blocks -> translate blocks */
export function toolReadableName(name: string): string {
  return name.replace(/[_-]+/g, ' ').trim()
}

/** The text of the line for a state (empty for idle). */
export function runStatusLabel(s: RunStatusState, lang: Lang): string {
  const t = AI_RUN_STATUS_STRINGS[lang]
  switch (s.phase) {
    case 'idle':
      return ''
    case 'running':
      if (s.tool) return t.tool.replace('{tool}', toolReadableName(s.tool))
      return s.writing ? t.writing : t.working
    case 'waiting':
      return t.waiting
    case 'done':
      return s.note ? `${t.done} · ${s.note}` : t.done
    case 'stopped':
      return t.stopped
    case 'error':
      return t.error
  }
}

/** m:ss, or h:mm:ss from an hour on. Language neutral on purpose. */
export function formatRunElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}
