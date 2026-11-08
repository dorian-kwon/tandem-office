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
    runner.start(units.slice(0, 2), ['copilot', 'connected-ai'], false)
    await settle()
    expect(asks).toEqual(['copilot:Paragraph 0', 'connected-ai:Paragraph 0'])
    first.resolve({ ok: true, text: 'First answer' })
    await settle()
    expect(asks).toEqual([
      'copilot:Paragraph 0',
      'connected-ai:Paragraph 0',
      'copilot:Paragraph 1',
      'connected-ai:Paragraph 1',
    ])
    expect(runner.getState().phase).toBe('done')
    expect(runner.getState().units[0]?.engines.copilot?.text).toBe('First answer')
    expect(runner.getState().units[1]?.engines['connected-ai']?.text).toBe(
      'connected-aiParagraph 1',
    )
  })

  it.each(['copilot', 'connected-ai'])(
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
      runner.start(units.slice(0, 2), ['copilot', 'connected-ai'], false)
      await settle()
      expect(calls).toEqual(['copilot:Paragraph 0', 'connected-ai:Paragraph 0'])
      replies.get(`${first}:Paragraph 0`)!.resolve({ ok: true, text: `${first} first` })
      await settle()
      expect(calls).toHaveLength(2)
      expect(integrations).toEqual([])
      const second = first === 'copilot' ? 'connected-ai' : 'copilot'
      replies.get(`${second}:Paragraph 0`)!.resolve({ ok: true, text: `${second} second` })
      await settle()
      expect(calls).toEqual([
        'copilot:Paragraph 0',
        'connected-ai:Paragraph 0',
        'copilot:Paragraph 1',
        'connected-ai:Paragraph 1',
      ])
      expect(integrations).toEqual([])
      replies.get(`${second}:Paragraph 1`)!.resolve({ ok: true, text: 'Second unit answer' })
      replies.get(`${first}:Paragraph 1`)!.resolve({ ok: true, text: 'Second unit answer' })
      await settle()
      expect(integrations).toEqual([])
      runner.integrateNow('u0')
      await settle()
      runner.integrateNow('u1')
      await settle()
      expect(integrations).toEqual([
        { unit: 'u0', engines: ['copilot', 'connected-ai'] },
        { unit: 'u1', engines: ['copilot', 'connected-ai'] },
      ])
      expect(runner.getState().phase).toBe('done')
    },
  )

  it('keeps the other engine running after one is blocked and never retries the blocked engine', async () => {
    const copilot = deferred<CompareAnswer>()
    const connected = deferred<CompareAnswer>()
    const calls: string[] = []
    let connectedSignal: AbortSignal | undefined
    const { runner } = setup({
      driver: {
        detect: async () => ({ installed: true }),
        ask: (engine, _prompt, signal) => {
          calls.push(engine)
          if (engine === 'connected-ai') connectedSignal = signal
          return engine === 'copilot' ? copilot.promise : connected.promise
        },
      },
    })
    runner.start(units.slice(0, 1), ['copilot', 'connected-ai'], false)
    await settle()
    copilot.resolve({ ok: false, reason: 'blocked' })
    await settle()
    expect(runner.getState().units[0]?.engines['connected-ai']?.status).toBe('running')
    expect(connectedSignal?.aborted).toBe(false)
    connected.resolve({ ok: true, text: 'Connected AI result' })
    await settle()
    runner.retry('u0', 'copilot')
    await settle()
    expect(calls).toEqual(['copilot', 'connected-ai'])
    expect(runner.getState().units[0]?.engines['connected-ai']?.text).toBe('Connected AI result')
    expect(runner.getState().phase).toBe('done')
  })

  it('collects both in-flight answers while paused and waits before the next unit', async () => {
    const copilot = deferred<CompareAnswer>()
    const connected = deferred<CompareAnswer>()
    const calls: string[] = []
    const { runner } = setup({
      driver: {
        detect: async () => ({ installed: true }),
        ask: (engine) => {
          calls.push(engine)
          return calls.length <= 2
            ? engine === 'copilot'
              ? copilot.promise
              : connected.promise
            : Promise.resolve({ ok: true, text: 'Next answer' })
        },
      },
    })
    runner.start(units.slice(0, 2), ['copilot', 'connected-ai'], false)
    await settle()
    runner.pause()
    copilot.resolve({ ok: true, text: 'Copilot result' })
    connected.resolve({ ok: true, text: 'Connected AI result' })
    await settle()
    expect(runner.getState().phase).toBe('paused')
    expect(runner.getState().units[0]?.engines.copilot?.text).toBe('Copilot result')
    expect(runner.getState().units[0]?.engines['connected-ai']?.text).toBe('Connected AI result')
    expect(calls).toEqual(['copilot', 'connected-ai'])
    runner.resume()
    await settle()
    expect(calls).toEqual(['copilot', 'connected-ai', 'copilot', 'connected-ai'])
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
    runner.start(units.slice(0, 1), ['copilot', 'connected-ai'], false)
    await settle()
    runner.stop()
    expect(signals).toHaveLength(2)
    expect(signals.every((s) => s.aborted)).toBe(true)
    runner.start(
      [{ id: 'new', text: 'New paragraph', korean: '' }],
      ['copilot', 'connected-ai'],
      false,
    )
    await settle()
    oldReplies[1]!.resolve({ ok: false, reason: 'blocked' })
    oldReplies[0]!.resolve({ ok: true, text: 'Old answer' })
    await settle()
    expect(runner.getState().units.map((u) => u.id)).toEqual(['new'])
    expect(runner.getState().units[0]?.engines.copilot?.text).toBe('New answer')
    expect(runner.getState().units[0]?.engines['connected-ai']?.text).toBe('New answer')
    expect(runner.getState().blocked).toEqual({})
    expect(runner.getState().phase).toBe('done')
  })

  it('deduplicates enabled engine ids so one engine cannot be started twice for a unit', async () => {
    const { runner, calls } = setup()
    runner.start(units.slice(0, 1), ['copilot', 'copilot', 'connected-ai'], false)
    await settle()
    expect(calls).toEqual(['copilot:Paragraph 0', 'connected-ai:Paragraph 0'])
    expect(runner.getState().engines).toEqual(['copilot', 'connected-ai'])
  })

  it('automatically integrates even when the main AI was also a candidate', async () => {
    let integrations = 0
    const { runner } = setup({
      integrate: async () => {
        integrations++
        return { ok: true, text: 'Explicit integration' }
      },
    })
    runner.start(units.slice(0, 1), ['copilot', 'connected-ai'], true)
    await settle()
    expect(runner.getState().units[0]?.integrate.status).toBe('done')
    expect(integrations).toBe(1)
    expect(runner.getState().units[0]?.integrate.text).toBe('Explicit integration')
  })

  it('invalidates and recomputes a final once after successful failed-candidate retries', async () => {
    let retry = false
    const finals: string[][] = []
    const pending = deferred<CompareAnswer>()
    const { runner } = setup({
      driver: {
        detect: async () => ({ installed: true }),
        ask: async (id) => {
          if (id === 'copilot') return { ok: true, text: 'Preserved' }
          return retry ? pending.promise : { ok: false, reason: 'temporary' }
        },
      },
      integrate: async (_, answers) => {
        finals.push(answers.map((a) => a.text))
        return { ok: true, text: finals.length === 1 ? 'Old final' : 'New final' }
      },
    })
    runner.start(units.slice(0, 1), ['copilot', 'connected-codex'], true)
    await settle()
    expect(finals).toEqual([['Preserved']])
    retry = true
    runner.retryFailed()
    await settle()
    expect(runner.getState().units[0]?.integrate.text).toBeUndefined()
    expect(runner.getState().units[0]?.engines.copilot?.text).toBe('Preserved')
    pending.resolve({ ok: true, text: 'Recovered' })
    await settle()
    expect(finals).toEqual([['Preserved'], ['Preserved', 'Recovered']])
    expect(runner.getState().units[0]?.integrate.text).toBe('New final')
  })

  it('does not spend another integration request when all candidate retries still fail', async () => {
    const integrate = vi.fn(async () => ({ ok: true as const, text: 'Preserved final' }))
    const { runner } = setup({
      driver: {
        detect: async () => ({ installed: true }),
        ask: async (id) =>
          id === 'copilot' ? { ok: true, text: 'Success' } : { ok: false, reason: 'temporary' },
      },
      integrate,
    })
    runner.start(units.slice(0, 1), ['copilot', 'connected-codex'], true)
    await settle()
    runner.retryFailed()
    await settle()
    expect(integrate).toHaveBeenCalledTimes(1)
    expect(runner.getState().units[0]?.integrate.text).toBe('Preserved final')
  })

  it('marks no-candidate integration retryable without calling the main AI', async () => {
    const integrate = vi.fn()
    const { runner } = setup({
      driver: {
        detect: async () => ({ installed: true }),
        ask: async () => ({ ok: false, reason: 'temporary' }),
      },
      integrate,
    })
    runner.start(units.slice(0, 1), ['connected-codex'], true)
    await settle()
    expect(integrate).not.toHaveBeenCalled()
    expect(runner.getState().units[0]?.integrate.status).toBe('failed')
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
            : { ok: true, text: 'Connected AI answer' }
        },
      },
    })
    runner.start(units, ['copilot', 'connected-ai'], false)
    await settle()
    runner.retry('u0', 'copilot')
    await settle()
    expect(asks).toEqual(['copilot', 'connected-ai', 'connected-ai', 'connected-ai'])
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
    runner.start(units, ['copilot', 'connected-ai'], false)
    await settle()
    expect(runner.getState().phase).toBe('allBlocked')
    expect(runner.getState().units[1]?.visited).toBe(false)
    expect(runner.getState().units[1]?.engines.copilot?.status).toBe('blocked')
  })

  it('waits for explicit continue after 20 units', async () => {
    const { runner, calls } = setup()
    runner.start(
      Array.from({ length: 21 }, (_, i) => ({ id: String(i), text: String(i), korean: '' })),
      ['connected-ai'],
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
    runner.start(units, ['connected-ai'], false)
    await settle()
    runner.stop()
    expect(signal?.aborted).toBe(true)
    pending.resolve({ ok: true, text: 'Too late' })
    await settle()
    expect(runner.getState().phase).toBe('stopped')
    expect(runner.getState().units[0]?.engines['connected-ai']).toEqual({ status: 'stopped' })
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
    runner.start(units.slice(0, 1), ['copilot', 'connected-ai'], false)
    await settle()
    runner.pause()
    runner.retry('u0', 'copilot')
    await settle()
    expect(asks).toEqual(['copilot', 'connected-ai'])
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

it('retry all targets failed pairs only and preserves successful, applied and blocked results', async () => {
  const calls: string[] = []
  const count = new Map<string, number>()
  const { runner } = setup({
    driver: {
      detect: async () => ({ installed: true }),
      ask: async (engine, prompt) => {
        const key = `${engine}:${prompt}`
        calls.push(key)
        count.set(key, (count.get(key) ?? 0) + 1)
        const failed =
          key === 'copilot:Paragraph 0' ||
          key === 'copilot:Paragraph 1' ||
          key === 'connected-ai:Paragraph 2'
        return failed && count.get(key) === 1
          ? { ok: false, reason: 'temporary failure' }
          : { ok: true, text: `answer ${key}` }
      },
    },
  })
  runner.start(units, ['copilot', 'connected-ai'], false)
  await settle()
  await settle()
  await settle()
  runner.markApplied('u0')
  const success = runner.getState().units[1]!.engines['connected-ai']
  runner.retryFailed()
  runner.retryFailed()
  await settle()
  await settle()
  expect(calls.slice(6)).toEqual(['copilot:Paragraph 1', 'connected-ai:Paragraph 2'])
  expect(runner.getState().units[0]!.applied).toBe(true)
  expect(runner.getState().units[0]!.engines.copilot?.status).toBe('failed')
  expect(runner.getState().units[1]!.engines['connected-ai']).toBe(success)
  expect(runner.getState().units[2]!.engines['connected-ai']?.status).toBe('done')
})

it('retry all skips stale units, stopped pairs and blocked engines', async () => {
  let retriesAllowed = true
  const calls: string[] = []
  const { runner } = setup({
    canRetry: () => retriesAllowed,
    driver: {
      detect: async () => ({ installed: true }),
      ask: async (engine) => {
        calls.push(engine)
        return { ok: false, reason: engine === 'copilot' ? 'blocked' : 'temporary failure' }
      },
    },
  })
  runner.start(units.slice(0, 1), ['copilot', 'connected-ai'], false)
  await settle()
  retriesAllowed = false
  runner.retryFailed()
  await settle()
  expect(calls).toEqual(['copilot', 'connected-ai'])
  retriesAllowed = true
  runner.retryFailed()
  await settle()
  expect(calls).toEqual(['copilot', 'connected-ai', 'connected-ai'])
})

it('stop cancels an active failed-only retry and ignores its late reply', async () => {
  const pending = deferred<CompareAnswer>()
  let count = 0
  let signal: AbortSignal | undefined
  const { runner } = setup({
    driver: {
      detect: async () => ({ installed: true }),
      ask: async (_engine, _prompt, s) => {
        signal = s
        return ++count === 1 ? { ok: false, reason: 'temporary failure' } : pending.promise
      },
    },
  })
  runner.start(units.slice(0, 1), ['copilot'], false)
  await settle()
  runner.retryFailed()
  await settle()
  runner.stop()
  expect(signal?.aborted).toBe(true)
  pending.resolve({ ok: true, text: 'late' })
  await settle()
  expect(runner.getState().phase).toBe('stopped')
  expect(runner.getState().units[0]!.engines.copilot?.text).toBeUndefined()
  runner.retryFailed()
  await settle()
  expect(count).toBe(2)
})
