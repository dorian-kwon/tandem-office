/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentLoopEvents, ToolExecution } from '@genoffice/agent-core'
import { AiRunStatusLine } from '../src/AiRunStatusLine'
import { IDLE_RUN_STATUS, reduceRunStatus, type RunStatusState } from '../src/ai-run-status'
import {
  RUN_STATUS_DONE_MS,
  useAiRunStatus,
  type AiRunStatusController,
} from '../src/use-ai-run-status'

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
    const running: RunStatusState = reduceRunStatus(IDLE_RUN_STATUS, {
      type: 'begin',
      at: Date.now(),
    })
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

  it('sends one measured progress event per successful live mutation and rejects stale or fabricated counts', () => {
    let ctl!: AiRunStatusController
    function Probe() {
      ctl = useAiRunStatus(true)
      return null
    }
    act(() => root.render(createElement(Probe)))
    const events = ctl.wrap({})
    const notify = vi.fn()
    const turn = (id: string) => ({
      id,
      observedBusy: true,
      inspected: false,
      operations: 0,
      mutated: false,
      notifyProgress: notify,
    })
    const call = () => ({ id: 'reused-model-id', name: 'translate_blocks', input: {} })
    const settle = (c: ReturnType<typeof call>, result: Partial<ToolExecution>) =>
      events.onToolExecuted?.({
        call: c,
        execution: { output: '100/100', runNote: '100%', summary: 'edited', ...result },
      })
    const run = (result: Partial<ToolExecution>) => {
      const c = call()
      events.onToolStart?.(c)
      settle(c, result)
      return c
    }
    act(() => {
      ctl.projectTurn.current = turn('one')
      const old = call()
      events.onToolStart?.(old)
      ctl.projectTurn.current = turn('two')
      settle(old, { mutated: true })
      run({ isError: true, mutated: true })
      run({})
      run({ translationProgress: { done: 0, total: 5 } })
      run({ translationProgress: { done: 0, total: 5 } })
      const c = run({ mutated: true, translationProgress: { done: 3, total: 5 } })
      settle(c, { mutated: true })
      run({ mutated: true, translationProgress: { done: 200, total: 5 } })
      run({ translationProgress: { done: 1, total: Infinity } })
      ctl.projectTurn.current!.stopRequested = true
      run({ mutated: true })
    })
    expect(notify.mock.calls.flat()).toEqual([
      { kind: 'progress', id: 'two', operations: 0, done: 0, total: 5 },
      { kind: 'progress', id: 'two', operations: 1, done: 3, total: 5 },
      { kind: 'progress', id: 'two', operations: 2 },
    ])
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
