import React, { useEffect, useState } from 'react'
import { brandText, type Lang } from '@genoffice/i18n'
import { formatRunElapsed, runStatusLabel, type RunStatusState } from './ai-run-status'
import './ai-run-status.css'

/**
 * The persistent status line above the AI composer: running (with what it does
 * and the elapsed time), waiting for the person, finished, stopped, error.
 * role="status" with polite announcements; the marker animation stops under
 * reduced motion. Renders nothing while idle.
 */
export function AiRunStatusLine({
  state,
  lang,
}: {
  readonly state: RunStatusState
  readonly lang: Lang
}): React.JSX.Element | null {
  const timed = state.phase === 'running' || state.phase === 'waiting'
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!timed) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [timed])

  if (state.phase === 'idle') return null
  const from = state.phase === 'waiting' && state.since > 0 ? state.since : state.startedAt
  const label = brandText(runStatusLabel(state, lang), lang)
  return (
    <div className="ai-run-status" data-phase={state.phase} role="status" aria-live="polite">
      <span className="ai-run-status-marker" aria-hidden />
      <span className="ai-run-status-label">{label}</span>
      {timed && from > 0 && (
        <span className="ai-run-status-elapsed" aria-hidden>
          {formatRunElapsed(now - from)}
        </span>
      )}
    </div>
  )
}
