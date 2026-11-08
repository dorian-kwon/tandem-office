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
  it('asks units in document order and only one engine at a time, retaining per-unit answers', async () => {
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
    expect(asks).toEqual(['copilot:Paragraph 0'])
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
