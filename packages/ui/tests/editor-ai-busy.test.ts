/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { AgentLoop, type AgentStreamCallbacks, type ToolExecution } from '@genoffice/agent-core'
import { useAiRunStatus, type AiRunStatusController } from '../src/use-ai-run-status'
import { describe, expect, it, vi } from 'vitest'
import { acquireEditorAiWork, useEditorAiBusy, withEditorAiWork } from '../src/editor-ai-busy'

describe('editor work lifetime', () => {
  it('keeps a cancelled AgentLoop tool busy after onDone until its real work settles', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const root = createRoot(document.createElement('div'))
    let status!: AiRunStatusController
    const Probe = ({ busy }: { busy: boolean }) => {
      status = useAiRunStatus(busy)
      return null
    }
    act(() => root.render(createElement(Probe, { busy: true })))
    let callbacks!: AgentStreamCallbacks
    let finish!: (value: ToolExecution) => void
    const done = vi.fn()
    const pending = vi.fn()
    const loop = new AgentLoop({
      transport: {
        stream: (_request, cb) => {
          callbacks = cb
          return { cancel() {} }
        },
      },
      skill: {
        id: 'test',
        systemPrompt: '',
        buildContext: () => '',
        tools: [{ name: 'edit', description: '', inputSchema: { type: 'object' } }],
        executeTool: () =>
          new Promise<ToolExecution>((resolve) => {
            finish = resolve
          }),
      },
      events: status.wrap({ onDone: done, onToolPending: pending }),
    })
    await act(async () => {
      loop.run('edit')
      await new Promise((resolve) => setTimeout(resolve, 0))
      callbacks.onToolCall({ id: '1', name: 'edit', input: {} })
      callbacks.onDone()
    })
    await act(async () => {
      loop.cancel()
    })
    expect(done).toHaveBeenCalledWith({ text: '', cancelled: true, turnLimit: false })
    act(() => root.render(createElement(Probe, { busy: false })))
    expect(window.__tandemEditorAiBusy).toBe(true)
    act(() => root.unmount())
    expect(window.__tandemEditorAiBusy).toBe(true)
    await act(async () => {
      finish({ output: 'done', summary: 'edit', mutated: true })
    })
    expect(pending.mock.calls.map((call) => call[1])).toEqual([true, false])
    expect(window.__tandemEditorAiBusy).toBe(false)
    vi.unstubAllGlobals()
  })

  it('keeps a background operation busy when the AI panel becomes idle or unmounts', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const host = document.createElement('div')
    const root = createRoot(host)
    const Probe = ({ busy }: { busy: boolean }) => {
      useEditorAiBusy(busy)
      return null
    }
    act(() => root.render(createElement(Probe, { busy: true })))
    const release = acquireEditorAiWork()
    act(() => root.render(createElement(Probe, { busy: false })))
    expect(window.__tandemEditorAiBusy).toBe(true)
    act(() => root.unmount())
    expect(window.__tandemEditorAiBusy).toBe(true)
    release()
    release()
    expect(window.__tandemEditorAiBusy).toBe(false)
    vi.unstubAllGlobals()
  })

  it('holds the guard through an awaited final write and releases on rejection', async () => {
    let reject!: (error: Error) => void
    const write = new Promise<void>((_resolve, fail) => {
      reject = fail
    })
    const operation = withEditorAiWork(() => write)
    expect(window.__tandemEditorAiBusy).toBe(true)
    const failure = expect(operation).rejects.toThrow('write failed')
    reject(new Error('write failed'))
    await failure
    expect(window.__tandemEditorAiBusy).toBe(false)
  })

  it('holds overlapping operations independently and releases a synchronous throw', async () => {
    const release = acquireEditorAiWork()
    await expect(
      withEditorAiWork(() => {
        throw new Error('failed')
      }),
    ).rejects.toThrow('failed')
    expect(window.__tandemEditorAiBusy).toBe(true)
    release()
    expect(window.__tandemEditorAiBusy).toBe(false)
  })
})
