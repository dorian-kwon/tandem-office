import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRunner, type RunnerDeps } from '../src/renderer/compare/runner'
import type { CompareAnswer } from '../src/shared/compare'

const units = Array.from({ length: 3 }, (_, i) => ({
  id: `u${i}`,
  text: `Paragraph ${i}`,
  korean: '',
}))
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}
async function settle() {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}
function setup(patch: Partial<RunnerDeps> = {}) {
  const calls: string[] = []
  const runner = createRunner({
    driver: {
      detect: async () => ({ installed: true }),
      ask: async (engine, prompt) => {
        calls.push(`${engine}:${prompt}`)
        return { ok: true, text: `answer ${prompt}` }
      },
    },
    promptFor: (u) => u.text,
    retranslateFor: () => false,
    integrate: async () => ({ ok: true, text: 'Integrated' }),
    paceMs: 0,
    sleep: async () => {},
    ...patch,
  })
  return { runner, calls }
}
afterEach(() => vi.useRealTimers())

describe('comparison scheduler', () => {
  it('asks both engines together while keeping units in document order and retaining their answers', async () => {
    const first = deferred<CompareAnswer>()
    const asks: string[] = []
    const { runner } = setup({
      driver: {
        detect: async () => ({ installed: true }),
        ask: async (engine, prompt) => {
          asks.push(`${engine}:${prompt}`)
          return asks.length === 1 ? first.promise : { ok: true, text: engine + prompt }
        },
      },
    })
    runner.start(units.slice(0, 2), ['copilot', 'grok'], false)
    await settle()
    expect(asks).toEqual(['copilot:Paragraph 0', 'grok:Paragraph 0'])
    first.resolve({ ok: true, text: 'First answer' })
    await settle()
    expect(asks).toEqual([
      'copilot:Paragraph 0',
      'grok:Paragraph 0',
      'copilot:Paragraph 1',
      'grok:Paragraph 1',
    ])
    expect(runner.getState().phase).toBe('done')
    expect(runner.getState().units[0]?.engines.copilot?.text).toBe('First answer')
    expect(runner.getState().units[1]?.engines.grok?.text).toBe('grokParagraph 1')
  })

  it.each(['copilot', 'grok'])(
    'waits for both answers when %s finishes first and integrates each unit once',
    async (first) => {
      const replies = new Map<string, ReturnType<typeof deferred<CompareAnswer>>>()
      const active = new Map<string, number>()
      const calls: string[] = []
      const integrations: Array<{ unit: string; engines: string[] }> = []
      const { runner } = setup({
        driver: {
          detect: async () => ({ installed: true }),
          ask: async (engine, prompt) => {
            active.set(engine, (active.get(engine) ?? 0) + 1)
            expect(active.get(engine)).toBe(1)
            const id = `${engine}:${prompt}`
            calls.push(id)
            const reply = deferred<CompareAnswer>()
            replies.set(id, reply)
            try {
              return await reply.promise
            } finally {
              active.set(engine, active.get(engine)! - 1)
            }
          },
        },
        integrate: async (unit, answers) => {
          integrations.push({ unit: unit.id, engines: answers.map((a) => a.id) })
          return { ok: true, text: `Integrated ${unit.id}` }
        },
      })
      runner.start(units.slice(0, 2), ['copilot', 'grok'], true)
      await settle()
      expect(calls).toEqual(['copilot:Paragraph 0', 'grok:Paragraph 0'])
      replies.get(`${first}:Paragraph 0`)!.resolve({ ok: true, text: `${first} first` })
      await settle()
      expect(calls).toHaveLength(2)
      expect(integrations).toEqual([])
      const second = first === 'copilot' ? 'grok' : 'copilot'
      replies.get(`${second}:Paragraph 0`)!.resolve({ ok: true, text: `${second} second` })
      await settle()
      expect(calls).toEqual([
        'copilot:Paragraph 0',
        'grok:Paragraph 0',
        'copilot:Paragraph 1',
        'grok:Paragraph 1',
      ])
      expect(integrations).toEqual([{ unit: 'u0', engines: ['copilot', 'grok'] }])
      replies.get(`${second}:Paragraph 1`)!.resolve({ ok: true, text: 'Second unit answer' })
      replies.get(`${first}:Paragraph 1`)!.resolve({ ok: true, text: 'Second unit answer' })
      await settle()
      expect(integrations).toEqual([
        { unit: 'u0', engines: ['copilot', 'grok'] },
        { unit: 'u1', engines: ['copilot', 'grok'] },
      ])
      expect(runner.getState().phase).toBe('done')
    },
  )

  it('keeps the other engine running after one is blocked and never retries the blocked engine', async () => {
    const copilot = deferred<CompareAnswer>()
    const grok = deferred<CompareAnswer>()
    const calls: string[] = []
    let grokSignal: AbortSignal | undefined
    const { runner } = setup({
      driver: {
        detect: async () => ({ installed: true }),
        ask: (engine, _prompt, signal) => {
          calls.push(engine)
          if (engine === 'grok') grokSignal = signal
          return engine === 'copilot' ? copilot.promise : grok.promise
        },
      },
    })
    runner.start(units.slice(0, 1), ['copilot', 'grok'], false)
    await settle()
    copilot.resolve({ ok: false, reason: 'blocked' })
    await settle()
    expect(runner.getState().units[0]?.engines.grok?.status).toBe('running')
    expect(grokSignal?.aborted).toBe(false)
    grok.resolve({ ok: true, text: 'Grok result' })
    await settle()
    runner.retry('u0', 'copilot')
    await settle()
    expect(calls).toEqual(['copilot', 'grok'])
    expect(runner.getState().units[0]?.engines.grok?.text).toBe('Grok result')
    expect(runner.getState().phase).toBe('done')
  })

  it('collects both in-flight answers while paused and waits before the next unit', async () => {
    const copilot = deferred<CompareAnswer>()
    const grok = deferred<CompareAnswer>()
    const calls: string[] = []
    const { runner } = setup({
      driver: {
        detect: async () => ({ installed: true }),
        ask: (engine) => {
          calls.push(engine)
          return calls.length <= 2
            ? engine === 'copilot'
              ? copilot.promise
              : grok.promise
            : Promise.resolve({ ok: true, text: 'Next answer' })
        },
      },
    })
    runner.start(units.slice(0, 2), ['copilot', 'grok'], false)
    await settle()
    runner.pause()
    copilot.resolve({ ok: true, text: 'Copilot result' })
    grok.resolve({ ok: true, text: 'Grok result' })
    await settle()
    expect(runner.getState().phase).toBe('paused')
    expect(runner.getState().units[0]?.engines.copilot?.text).toBe('Copilot result')
    expect(runner.getState().units[0]?.engines.grok?.text).toBe('Grok result')
    expect(calls).toEqual(['copilot', 'grok'])
    runner.resume()
    await settle()
    expect(calls).toEqual(['copilot', 'grok', 'copilot', 'grok'])
    expect(runner.getState().phase).toBe('done')
  })

  it('stop cancels every active engine and late replies cannot alter a new run', async () => {
    const oldReplies = [deferred<CompareAnswer>(), deferred<CompareAnswer>()]
    const signals: AbortSignal[] = []
    let calls = 0
    const { runner } = setup({
      driver: {
        detect: async () => ({ installed: true }),
        ask: (_engine, _prompt, signal) => {
          signals.push(signal)
          return calls++ < 2
            ? oldReplies[calls - 1]!.promise
            : Promise.resolve({ ok: true, text: 'New answer' })
        },
      },
    })
    runner.start(units.slice(0, 1), ['copilot', 'grok'], false)
    await settle()
    runner.stop()
    expect(signals).toHaveLength(2)
    expect(signals.every((s) => s.aborted)).toBe(true)
    runner.start([{ id: 'new', text: 'New paragraph', korean: '' }], ['copilot', 'grok'], false)
    await settle()
    oldReplies[1]!.resolve({ ok: false, reason: 'blocked' })
    oldReplies[0]!.resolve({ ok: true, text: 'Old answer' })
    await settle()
    expect(runner.getState().units.map((u) => u.id)).toEqual(['new'])
    expect(runner.getState().units[0]?.engines.copilot?.text).toBe('New answer')
    expect(runner.getState().units[0]?.engines.grok?.text).toBe('New answer')
    expect(runner.getState().blocked).toEqual({})
    expect(runner.getState().phase).toBe('done')
  })

  it('deduplicates enabled engine ids so one engine cannot be started twice for a unit', async () => {
    const { runner, calls } = setup()
    runner.start(units.slice(0, 1), ['copilot', 'copilot', 'grok'], false)
    await settle()
    expect(calls).toEqual(['copilot:Paragraph 0', 'grok:Paragraph 0'])
    expect(runner.getState().engines).toEqual(['copilot', 'grok'])
  })

  it('marks blocked engines once and skips them in later units and manual retries', async () => {
    const asks: string[] = []
    const { runner } = setup({
      driver: {
        detect: async () => ({ installed: true }),
        ask: async (engine) => {
          asks.push(engine)
          return engine === 'copilot'
            ? { ok: false, reason: 'blocked' }
            : { ok: true, text: 'Grok answer' }
        },
      },
    })
    runner.start(units, ['copilot', 'grok'], false)
    await settle()
    runner.retry('u0', 'copilot')
    await settle()
    expect(asks).toEqual(['copilot', 'grok', 'grok', 'grok'])
    expect(runner.getState().units[2]?.engines.copilot).toEqual({
      status: 'blocked',
      reason: 'blocked',
    })
    expect(runner.getState().phase).toBe('done')
  })

  it('stops if all engines are blocked', async () => {
    const { runner } = setup({
      driver: {
        detect: async () => ({ installed: true }),
        ask: async () => ({ ok: false, reason: 'needs-user' }),
      },
    })
    runner.start(units, ['copilot', 'grok'], false)
    await settle()
    expect(runner.getState().phase).toBe('allBlocked')
    expect(runner.getState().units[1]?.visited).toBe(false)
    expect(runner.getState().units[1]?.engines.copilot?.status).toBe('blocked')
  })

  it('waits for explicit continue after 20 units', async () => {
    const { runner, calls } = setup()
    runner.start(
      Array.from({ length: 21 }, (_, i) => ({ id: String(i), text: String(i), korean: '' })),
      ['grok'],
      false,
    )
    for (let i = 0; i < 10; i++) await settle()
    expect(calls).toHaveLength(20)
    expect(runner.getState().phase).toBe('batchDone')
    runner.continueNext()
    await settle()
    expect(calls).toHaveLength(21)
    expect(runner.getState().phase).toBe('done')
  })

  it('pause during the final call waits for resume even with integration disabled', async () => {
    const pending = deferred<CompareAnswer>()
    const { runner } = setup({
      driver: { detect: async () => ({ installed: true }), ask: () => pending.promise },
    })
    runner.start(units.slice(0, 1), ['copilot'], false)
    await settle()
    runner.pause()
    pending.resolve({ ok: true, text: 'Finished call' })
    await settle()
    expect(runner.getState().phase).toBe('paused')
    runner.resume()
    await settle()
    expect(runner.getState().phase).toBe('done')
  })

  it('stop aborts a pending call and ignores a late reply', async () => {
    const pending = deferred<CompareAnswer>()
    let signal: AbortSignal | undefined
    const { runner } = setup({
      driver: {
        detect: async () => ({ installed: true }),
        ask: (_e, _p, s) => {
          signal = s
          return pending.promise
        },
      },
    })
    runner.start(units, ['grok'], false)
    await settle()
    runner.stop()
    expect(signal?.aborted).toBe(true)
    pending.resolve({ ok: true, text: 'Too late' })
    await settle()
    expect(runner.getState().phase).toBe('stopped')
    expect(runner.getState().units[0]?.engines.grok).toEqual({ status: 'stopped' })
  })

  it('does not run a manual retry while a paused call is still in flight', async () => {
    const second = deferred<CompareAnswer>()
    const asks: string[] = []
    const { runner } = setup({
      driver: {
        detect: async () => ({ installed: true }),
        ask: async (engine) => {
          asks.push(engine)
          return asks.length === 1 ? { ok: false, reason: 'temporary failure' } : second.promise
        },
      },
    })
    runner.start(units.slice(0, 1), ['copilot', 'grok'], false)
    await settle()
    runner.pause()
    runner.retry('u0', 'copilot')
    await settle()
    expect(asks).toEqual(['copilot', 'grok'])
    runner.stop()
    second.resolve({ ok: true, text: 'late' })
  })

  it('manual integration cannot overlap itself or a newly started run', async () => {
    const pending = deferred<CompareAnswer>()
    let integrations = 0
    const { runner } = setup({
      integrate: async () => {
        integrations++
        return pending.promise
      },
    })
    runner.start(units.slice(0, 1), ['copilot'], false)
    await settle()
    runner.integrateNow('u0')
    runner.integrateNow('u0')
    await settle()
    expect(integrations).toBe(1)
    runner.stop()
    pending.resolve({ ok: true, text: 'Late integration' })
    await settle()
    expect(runner.getState().units[0]?.integrate.status).not.toBe('done')
  })
})
