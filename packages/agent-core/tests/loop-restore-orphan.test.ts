import { describe, expect, it } from 'vitest'
import {
  AgentLoop,
  TOOL_ABORTED_OUTPUT,
  type AgentMessage,
  type AgentStreamCallbacks,
  type AgentToolCall,
  type AgentTransport,
  type ToolExecution,
} from '../src'

function scriptedTransport(script: Array<(cb: AgentStreamCallbacks) => void>): AgentTransport & {
  requests: Array<{ messages: AgentMessage[]; system: string }>
} {
  let turn = 0
  const transport = {
    requests: [] as Array<{ messages: AgentMessage[]; system: string }>,
    stream(request: { messages: AgentMessage[]; system: string }, cb: AgentStreamCallbacks) {
      transport.requests.push({ messages: request.messages, system: request.system })
      const step = script[turn++]
      if (step) queueMicrotask(() => step(cb))
      return { cancel: () => queueMicrotask(() => cb.onDone()) }
    },
  }
  return transport
}

function makeSkill() {
  return {
    id: 'test',
    systemPrompt: 'system',
    tools: [{ name: 'do_thing', description: 'd', inputSchema: { type: 'object' } }],
    buildContext: () => '',
    executeTool: (): ToolExecution => ({ output: 'ok', summary: 'done', mutated: true }),
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('AgentLoop.restore orphan tool calls', () => {
  it('pairs an assistant tool call that never got results with an isError result', () => {
    const loop = new AgentLoop({ transport: scriptedTransport([]), skill: makeSkill() })
    loop.restore([
      { role: 'user', text: 'do the thing' },
      {
        role: 'assistant',
        text: 'calling the tool',
        toolCalls: [{ id: 't1', name: 'do_thing', input: { a: 1 } }],
      },
    ])
    expect(loop.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
    const tool = loop.messages[2] as Extract<AgentMessage, { role: 'tool' }>
    expect(tool.results).toEqual([
      { id: 't1', name: 'do_thing', output: TOOL_ABORTED_OUTPUT, isError: true },
    ])
  })

  it('leaves an assistant tool call that already has results untouched', () => {
    const loop = new AgentLoop({ transport: scriptedTransport([]), skill: makeSkill() })
    loop.restore([
      { role: 'user', text: 'do the thing' },
      {
        role: 'assistant',
        text: '',
        toolCalls: [{ id: 't1', name: 'do_thing', input: { a: 1 } }],
      },
      { role: 'tool', results: [{ id: 't1', name: 'do_thing', output: 'ok' }] },
      { role: 'assistant', text: 'done' },
    ])
    expect(loop.messages).toHaveLength(4)
    const tool = loop.messages[2] as Extract<AgentMessage, { role: 'tool' }>
    expect(tool.results).toEqual([{ id: 't1', name: 'do_thing', output: 'ok' }])
  })

  it('the next run sends a transcript with no unpaired tool calls', async () => {
    const transport = scriptedTransport([
      (cb) => {
        cb.onDelta('picking up')
        cb.onDone()
      },
    ])
    const loop = new AgentLoop({ transport, skill: makeSkill() })
    loop.restore([
      { role: 'user', text: 'do the thing' },
      {
        role: 'assistant',
        text: 'calling the tool',
        toolCalls: [{ id: 't1', name: 'do_thing', input: { a: 1 } }],
      },
    ])
    loop.run('follow-up')
    await flush()
    const sent = transport.requests[0]!.messages
    const callIds = sent.flatMap((m) =>
      m.role === 'assistant' ? (m.toolCalls ?? []).map((c: AgentToolCall) => c.id) : [],
    )
    const resultIds = sent.flatMap((m) => (m.role === 'tool' ? m.results.map((r) => r.id) : []))
    for (const id of callIds) {
      expect(resultIds).toContain(id)
    }
    expect(callIds.length).toBeGreaterThan(0)
  })
})

it('preserves a confirmed receipt alongside an unconfirmed sibling when resuming a restored batch', async () => {
  const transport = scriptedTransport([(cb) => cb.onDone()])
  const loop = new AgentLoop({ transport, skill: makeSkill() })
  loop.restore([
    { role: 'user', text: 'Translate both paragraphs' },
    {
      role: 'assistant',
      text: '',
      toolCalls: [
        { id: 'p1', name: 'do_thing', input: {} },
        { id: 'p2', name: 'do_thing', input: {} },
      ],
    },
    { role: 'tool', results: [{ id: 'p1', name: 'do_thing', output: 'Paragraph 1 committed' }] },
  ])
  loop.run('Resume.')
  await flush()
  const req = transport.requests[0]!
  expect(req.messages.find((m) => m.role === 'tool')).toMatchObject({
    results: [
      { id: 'p1', output: 'Paragraph 1 committed' },
      { id: 'p2', output: TOOL_ABORTED_OUTPUT, isError: true },
    ],
  })
  expect(req.system).toContain('read the current document')
})
