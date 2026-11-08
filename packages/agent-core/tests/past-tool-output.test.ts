import { describe, expect, it } from 'vitest'
import {
  AgentLoop,
  type AgentSkill,
  type AgentStreamRequest,
  type AgentStreamCallbacks,
} from '../src'

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const full = 'Source paragraph. '.repeat(1000)

async function scenario(
  limits?: Readonly<Record<string, number>>,
  readError = false,
  compact = false,
) {
  const requests: AgentStreamRequest[] = []
  const callbacks: AgentStreamCallbacks[] = []
  let activeLimits = limits
  const skill: AgentSkill = {
    id: 'test',
    systemPrompt: 'system',
    tools: ['read_runs', 'use_skill'].map((name) => ({
      name,
      description: name,
      inputSchema: { type: 'object' },
    })),
    executeTool: (call) => ({
      output:
        call.name === 'read_runs' ? full : 'Keep the complete skill instructions. '.repeat(100),
      summary: 'read',
      isError: call.name === 'read_runs' && readError,
    }),
  }
  const loop = new AgentLoop({
    skill,
    compaction: compact
      ? { maxBytes: 6000, keepRecentBytes: 1000, disableLlmSummary: true }
      : false,
    get pastToolOutputLimits() {
      return activeLimits
    },
    transport: {
      stream(request, cb) {
        requests.push(request)
        callbacks.push(cb)
        return { cancel: () => cb.onDone() }
      },
    },
  })
  loop.run('Translate paragraph one')
  await flush()
  callbacks[0]!.onToolCall({ id: 'r1', name: 'read_runs', input: { startBlockIndex: 0 } })
  callbacks[0]!.onToolCall({ id: 's1', name: 'use_skill', input: { name: 'translation' } })
  callbacks[0]!.onDone()
  await flush()
  const current = requests[1]!
  callbacks[1]!.onDelta('Translated paragraph one')
  callbacks[1]!.onDone()
  loop.run('Now translate paragraph two')
  await flush()
  return {
    loop,
    requests,
    callbacks,
    current,
    setLimits: (value: typeof limits) => {
      activeLimits = value
    },
  }
}

const outputs = (request: AgentStreamRequest) =>
  request.messages.flatMap((m) => (m.role === 'tool' ? m.results : []))

describe('past tool output limits', () => {
  it('shortens only configured results from earlier requests, preserving current work and full history', async () => {
    const { loop, requests, current } = await scenario({ read_runs: 4000 })
    expect(outputs(current)[0]!.output).toBe(full)
    const past = outputs(requests[2]!)[0]!
    expect(past.output.length).toBeLessThan(4200)
    expect(past.output).toContain('read the source again')
    expect(past).toMatchObject({ id: 'r1', name: 'read_runs' })
    expect(outputs(requests[2]!)[1]!.output).toBe(
      'Keep the complete skill instructions. '.repeat(100),
    )
    expect(loop.messages.flatMap((m) => (m.role === 'tool' ? m.results : []))[0]!.output).toBe(full)
    expect(requests[2]!.messages).toContainEqual({ role: 'user', text: 'Translate paragraph one' })
    expect(requests[2]!.messages).toContainEqual({
      role: 'user',
      text: 'Now translate paragraph two',
    })
    expect(requests[2]!.messages.find((m) => m.role === 'assistant' && m.toolCalls)).toMatchObject({
      toolCalls: [
        { id: 'r1', name: 'read_runs', input: { startBlockIndex: 0 } },
        { id: 's1', name: 'use_skill', input: { name: 'translation' } },
      ],
    })
    expect(requests).toHaveLength(3)
    loop.cancel()
  })

  it('keeps normal requests byte-identical when no limits are selected', async () => {
    const { loop, requests } = await scenario()
    expect(outputs(requests[2]!)[0]!.output).toBe(full)
    loop.cancel()
  })

  it('keeps new document reads complete even when an earlier run is shortened', async () => {
    const { loop, requests, callbacks } = await scenario({ read_runs: 4000 })
    callbacks[2]!.onToolCall({ id: 'r2', name: 'read_runs', input: { startBlockIndex: 1 } })
    callbacks[2]!.onDone()
    await flush()
    expect(outputs(requests[3]!)[0]!.output.length).toBeLessThan(4200)
    expect(outputs(requests[3]!).at(-1)!.output).toBe(full)
    loop.cancel()
  })

  it('keeps earlier error details complete', async () => {
    const { loop, requests } = await scenario({ read_runs: 4000 }, true)
    expect(outputs(requests[2]!)[0]).toMatchObject({ output: full, isError: true })
    loop.cancel()
  })

  it('keeps the current request boundary after older conversation is compacted', async () => {
    const { loop, requests, callbacks } = await scenario({ read_runs: 4000 }, false, true)
    callbacks[2]!.onToolCall({ id: 'r2', name: 'read_runs', input: { startBlockIndex: 1 } })
    callbacks[2]!.onDone()
    await flush()
    callbacks[3]!.onDelta('Translated paragraph two')
    callbacks[3]!.onDone()
    loop.run('Translate paragraph three')
    await flush()
    const next = requests[4]!
    expect(next.messages[0]).toMatchObject({
      role: 'user',
      text: expect.stringContaining('auto-compacted'),
    })
    expect(outputs(next)).toHaveLength(1)
    expect(outputs(next)[0]).toMatchObject({
      id: 'r2',
      output: expect.stringContaining('read the source again'),
    })
    callbacks[4]!.onToolCall({ id: 'r3', name: 'read_runs', input: { startBlockIndex: 2 } })
    callbacks[4]!.onDone()
    await flush()
    expect(outputs(requests[5]!).at(-1)).toMatchObject({ id: 'r3', output: full })
    loop.cancel()
  })

  it('rechecks limits between turns without modifying stored messages', async () => {
    const { loop, requests, callbacks, setLimits } = await scenario({ read_runs: 4000 })
    setLimits(undefined)
    callbacks[2]!.onToolCall({ id: 'r2', name: 'read_runs', input: { startBlockIndex: 1 } })
    callbacks[2]!.onDone()
    await flush()
    expect(outputs(requests[3]!).map((r) => r.output)).toEqual([
      full,
      'Keep the complete skill instructions. '.repeat(100),
      full,
    ])
    loop.cancel()
  })

  it('ignores invalid limits', async () => {
    for (const limit of [0, -1, NaN, Infinity]) {
      const { loop, requests } = await scenario({ read_runs: limit })
      expect(outputs(requests[2]!)[0]!.output).toBe(full)
      loop.cancel()
    }
  })
})
