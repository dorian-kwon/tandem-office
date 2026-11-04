/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentLoopEvents } from '@genoffice/agent-core'
import { AiRunStatusLine } from '../src/AiRunStatusLine'
import { IDLE_RUN_STATUS, reduceRunStatus, type RunStatusState } from '../src/ai-run-status'
import { RUN_STATUS_DONE_MS, useAiRunStatus, type AiRunStatusController } from '../src/use-ai-run-status'

describe('AiRunStatusLine and useAiRunStatus', () => {
  let host: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('renders nothing while idle, a polite status region while running', () => {
    act(() => root.render(createElement(AiRunStatusLine, { state: IDLE_RUN_STATUS, lang: 'en' })))
    expect(host.querySelector('[role="status"]')).toBeNull()
    const running: RunStatusState = reduceRunStatus(IDLE_RUN_STATUS, { type: 'begin', at: Date.now() })
    act(() => root.render(createElement(AiRunStatusLine, { state: running, lang: 'en' })))
    const line = host.querySelector('[role="status"]')
    expect(line?.getAttribute('aria-live')).toBe('polite')
    expect(line?.textContent).toContain('Working')
    expect(line?.textContent).toContain('0:00')
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(host.textContent).toContain('0:03')
  })

  it('follows the real loop events through the hook, from tool to wait to done', () => {
    let ctl!: AiRunStatusController
    const Probe = ({ busy }: { busy: boolean }) => {
      ctl = useAiRunStatus(busy)
      return createElement(AiRunStatusLine, { state: ctl.state, lang: 'en' })
    }
    act(() => root.render(createElement(Probe, { busy: false })))
    const events: AgentLoopEvents<unknown> = ctl.wrap({})
    act(() => root.render(createElement(Probe, { busy: true })))
    expect(host.textContent).toContain('Working')

    act(() => events.onToolStart?.({ id: '1', name: 'translate_blocks', input: {} }))
    expect(host.textContent).toContain('Running a tool: translate blocks')

    act(() =>
      events.onToolExecuted?.({
        call: { id: '1', name: 'ocr_pictures', input: {} },
        execution: { output: 'popup open, wait', summary: 's', awaitingUser: true },
      }),
    )
    expect(host.textContent).toContain('Waiting for you to confirm in the popup')

    act(() => events.onDone?.({ text: 'ok', cancelled: false, turnLimit: false }))
    act(() => root.render(createElement(Probe, { busy: false })))
    // the wait outlives the run
    expect(host.textContent).toContain('Waiting for you')

    act(() => ctl.resolveWaiting())
    expect(host.querySelector('[role="status"]')).toBeNull()
  })

  it('shows Finished with the tool note, then dismisses itself', () => {
    let ctl!: AiRunStatusController
    const Probe = ({ busy }: { busy: boolean }) => {
      ctl = useAiRunStatus(busy)
      return createElement(AiRunStatusLine, { state: ctl.state, lang: 'en' })
    }
    act(() => root.render(createElement(Probe, { busy: false })))
    const events: AgentLoopEvents<unknown> = ctl.wrap({})
    act(() => root.render(createElement(Probe, { busy: true })))
    act(() =>
      events.onToolExecuted?.({
        call: { id: '1', name: 'translate_blocks', input: {} },
        execution: { output: '', summary: 's', runNote: 'Nothing is left' },
      }),
    )
    act(() => events.onDone?.({ text: 'x', cancelled: false, turnLimit: false }))
    act(() => root.render(createElement(Probe, { busy: false })))
    expect(host.textContent).toContain('Finished · Nothing is left')
    act(() => {
      vi.advanceTimersByTime(RUN_STATUS_DONE_MS + 10)
    })
    expect(host.querySelector('[role="status"]')).toBeNull()
  })

  it('says Stopped on a user stop and keeps the panel handlers', () => {
    let ctl!: AiRunStatusController
    const own = vi.fn()
    const Probe = ({ busy }: { busy: boolean }) => {
      ctl = useAiRunStatus(busy)
      return createElement(AiRunStatusLine, { state: ctl.state, lang: 'en' })
    }
    act(() => root.render(createElement(Probe, { busy: false })))
    const events: AgentLoopEvents<unknown> = ctl.wrap({ onDone: own })
    act(() => root.render(createElement(Probe, { busy: true })))
    act(() => events.onDone?.({ text: '', cancelled: true, turnLimit: false }))
    expect(host.textContent).toContain('Stopped')
    expect(own).toHaveBeenCalledTimes(1)
  })

  it('marks an error and stays until the next run', () => {
    let ctl!: AiRunStatusController
    const Probe = ({ busy }: { busy: boolean }) => {
      ctl = useAiRunStatus(busy)
      return createElement(AiRunStatusLine, { state: ctl.state, lang: 'en' })
    }
    act(() => root.render(createElement(Probe, { busy: false })))
    const events: AgentLoopEvents<unknown> = ctl.wrap({})
    act(() => root.render(createElement(Probe, { busy: true })))
    act(() => events.onError?.('boom with C:\\secret\\path'))
    act(() => root.render(createElement(Probe, { busy: false })))
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(host.textContent).toContain('Stopped by an error')
    // the raw error text never reaches the line
    expect(host.textContent).not.toContain('secret')
    act(() => root.render(createElement(Probe, { busy: true })))
    expect(host.textContent).toContain('Working')
  })
})
