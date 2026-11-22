import { expect, it, vi } from 'vitest'
import type { AgentToolCall, AgentTransport } from '@genoffice/agent-core'
import { BatchProjectAgent, type BatchAgentTask } from '../src/main/translate/batch-project-agent'

function model(turns: (string | Error | AgentToolCall)[]): AgentTransport {
  return {
    stream(_request, callbacks) {
      queueMicrotask(() => {
        const next = turns.shift()
        if (next instanceof Error) return callbacks.onError(next.message)
        if (!next) return callbacks.onError('Unexpected request')
        if (typeof next === 'string') callbacks.onDelta(next)
        else callbacks.onToolCall(next)
        callbacks.onDone()
      })
      return { cancel() {} }
    },
  }
}
const edit = { id: 'edit', name: 'edit_text', input: {} }
function task(
  turns: (string | Error | AgentToolCall)[],
  finish: (changed: boolean) => Promise<void>,
): BatchAgentTask {
  return {
    transport: model(turns),
    signal: new AbortController().signal,
    instructions: '',
    items: [
      { file: 'one', state: 'saved' },
      { file: 'two', state: 'saved' },
    ],
    open: vi.fn(async () => ({
      tools: [
        {
          name: edit.name,
          description: 'Edit text',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      systemPrompt: '',
      executeTool: async () => ({ summary: 'Edited', output: 'ok', mutated: true }),
      finish,
    })),
  }
}

it('saves applied edits even if the provider fails before providing its completion report', async () => {
  const finish = vi.fn(async () => {})
  const request = task([edit, new Error('Connection lost')], finish)
  await expect(new BatchProjectAgent().run(request, 'Translate', 'one')).rejects.toThrow(
    'Connection lost',
  )
  expect(finish).toHaveBeenCalledExactlyOnceWith(true)
})

it('does not accept a claimed success or open the next editor after a failed save on switching', async () => {
  const select = (file: string) => ({
    id: 'select-' + file,
    name: 'select_batch_document',
    input: { file },
  })
  const request = task([select('one'), edit, select('two'), 'Done'], async () => {
    throw new Error('Disk full')
  })
  await expect(new BatchProjectAgent().run(request, 'Change both files')).rejects.toThrow(
    'Disk full',
  )
  expect(request.open).toHaveBeenCalledExactlyOnceWith('one')
})

it('notifies batch chat about edits only in the document that its tool changed', async () => {
  const select = (file: string) => ({
    id: 'select-' + file,
    name: 'select_batch_document',
    input: { file },
  })
  const read = { id: 'read', name: 'read_document', input: {} }
  const request = task([select('one'), read, select('two'), edit, edit, 'Finished'], async () => {})
  request.onMutated = vi.fn()
  request.open = vi.fn(async () => ({
    systemPrompt: '',
    tools: [read, edit].map((tool) => ({
      name: tool.name,
      description: tool.name,
      inputSchema: { type: 'object', properties: {} },
    })),
    executeTool: async (call) => ({
      summary: 'ok',
      output: 'ok',
      mutated: call.name === edit.name,
    }),
    finish: async () => {},
  }))
  await new BatchProjectAgent().run(request, 'Read one and edit two')
  expect(request.onMutated).toHaveBeenCalledExactlyOnceWith('two')
})

it.each([true, false])(
  'checks the Word output after the model declares it complete (can finish: %s)',
  async (canFinish) => {
    const request = task(
      ['Done', 'Done'],
      vi.fn(async () => {}),
    )
    request.sourceLanguage = 'ko'
    request.report = vi.fn()
    let checks = 0
    const finish = vi.fn(async () => {})
    request.open = async () => ({
      tools: [{ name: 'read_runs', description: '', inputSchema: {} }],
      systemPrompt: '',
      executeTool: async (call) => {
        expect(call.input).toEqual({
          checkRemaining: true,
          sourceLanguage: 'ko',
          ...(checks > 0 ? { includePendingRuns: true } : {}),
        })
        const done = [0, 249, canFinish ? 252 : 249][checks++]!
        return {
          output: 'Check includes the header.',
          summary: '',
          translationProgress: { done, total: 252 },
        }
      },
      finish,
    })
    const run = new BatchProjectAgent().run(request, 'Translate', 'one')
    if (canFinish) {
      await expect(run).resolves.toBe('Done')
      expect(request.report).toHaveBeenLastCalledWith({
        done: 252,
        total: 252,
        operations: 0,
        verified: true,
      })
    } else {
      await expect(run).rejects.toThrow('249/252')
      expect(request.report).not.toHaveBeenCalledWith(expect.objectContaining({ verified: true }))
    }
    expect(checks).toBe(3)
    expect(finish).toHaveBeenCalledTimes(1)
  },
)

it('refuses to certify an output when counted source units disappear without translation receipts', async () => {
  const request = task(['Done'], async () => {})
  request.sourceLanguage = 'ko'
  let reads = 0
  request.open = async () => ({
    tools: [{ name: 'read_runs', description: '', inputSchema: {} }],
    systemPrompt: '',
    executeTool: async () => ({
      output: '',
      summary: '',
      translationProgress: { done: 0, total: reads++ === 0 ? 3 : 0 },
    }),
    finish: async () => {},
  })
  await expect(new BatchProjectAgent().run(request, 'Translate', 'one')).rejects.toThrow(
    'account for all',
  )
})

it('passes remaining textbox paragraphs from the editor to the next model turn as one batch', async () => {
  const locations = [2, 3, 6].map((box) => ({
    index: 197,
    box,
    paragraph: 0,
    fp: 'fp-' + box,
    segments: ['원문'],
  }))
  const blocks = locations.map((location) => ({ ...location, segments: ['Translated'] }))
  const editBoxes = { id: 'boxes', name: 'translate_blocks', input: { blocks } }
  const finish = vi.fn(async () => {})
  const request = task(['Done', editBoxes, 'Done'], finish)
  const stream = vi.spyOn(request.transport, 'stream')
  request.sourceLanguage = 'ko'
  let translated = false
  request.open = async () => ({
    tools: ['read_runs', 'translate_blocks'].map((name) => ({
      name,
      description: '',
      inputSchema: {},
    })),
    systemPrompt: '',
    executeTool: async (call) => {
      if (call.name === 'translate_blocks') {
        expect(call.input.blocks).toEqual(blocks)
        translated = true
        return { output: 'OK', summary: '', mutated: true }
      }
      return {
        output:
          call.input.includePendingRuns && !translated
            ? locations.map((unit) => JSON.stringify(unit)).join('\n')
            : 'Check',
        summary: '',
        translationProgress: { done: translated ? 36 : 33, total: 36 },
      }
    },
    finish,
  })
  await new BatchProjectAgent().run(request, 'Translate', 'one')
  const continuation = stream.mock.calls[1]![0].messages.at(-1)!.text
  for (const unit of locations) expect(continuation).toContain(JSON.stringify(unit))
  expect(finish).toHaveBeenCalledExactlyOnceWith(true)
})
