import { useCallback, useEffect, useRef, useState } from 'react'
import type { RunStatusState } from './ai-run-status'

/**
 * No run event for this long and the lock lets go on its own. Every tool start,
 * tool end and streamed text chunk moves the run status, so a live run keeps
 * re-arming it; only a run whose end was never reported (a dropped connection)
 * reaches it. It does not stop the run: the AI re-reads paragraph fingerprints
 * before it writes, so a late write over the person's edit is refused.
 */
export const TRANSLATION_LOCK_IDLE_MS = 5 * 60 * 1000

/**
 * The single rule: the translation output is locked while the AI is running.
 * While it waits for the person (a popup the AI itself asked for) it is paused,
 * so the person may edit; every end (done, stopped, error) and idle unlock.
 */
export function translationLockWanted(isOutput: boolean, state: RunStatusState): boolean {
  return isOutput && state.phase === 'running'
}

export interface TranslationLockController {
  /** the output editor must be read-only and the banner shown */
  readonly locked: boolean
  /** the Unlock button: release the lock now and stop the run if one is active */
  unlock(): void
}

export interface UseTranslationLockOptions {
  readonly state: RunStatusState
  /**
   * Asks the shell whether this window is the translation view's output pane.
   * Absent (an editor without the bridge) or failing: not an output, no lock.
   */
  readonly probe?: (() => Promise<boolean>) | undefined
  /** stop the active AI run (the panel's own cancel) */
  readonly onStop?: (() => void) | undefined
}

/**
 * Lock state for the translation view's output pane, derived from the shared
 * run status (`useAiRunStatus`). The probe runs each time a run begins, so a
 * document that became a translation output after it loaded is still found.
 * An explicit release lasts until the run leaves `running`.
 */
export function useTranslationLock({
  state,
  probe,
  onStop,
}: UseTranslationLockOptions): TranslationLockController {
  const [isOutput, setIsOutput] = useState(false)
  const [released, setReleased] = useState(false)
  const probeRef = useRef(probe)
  probeRef.current = probe
  const stopRef = useRef(onStop)
  stopRef.current = onStop
  const isRunning = state.phase === 'running'

  useEffect(() => {
    if (!isRunning) {
      setReleased(false)
      return undefined
    }
    let alive = true
    const ask = probeRef.current
    if (!ask) {
      setIsOutput(false)
      return undefined
    }
    ask().then(
      (answer) => alive && setIsOutput(answer === true),
      () => alive && setIsOutput(false),
    )
    return () => {
      alive = false
    }
  }, [isRunning])

  const locked = translationLockWanted(isOutput, state) && !released

  // `state` is a new object on each run event, which re-arms the watchdog
  useEffect(() => {
    if (!locked) return undefined
    const timer = setTimeout(() => setReleased(true), TRANSLATION_LOCK_IDLE_MS)
    return () => clearTimeout(timer)
  }, [locked, state])

  const unlock = useCallback(() => {
    setReleased(true)
    stopRef.current?.()
  }, [])
  return { locked, unlock }
}
