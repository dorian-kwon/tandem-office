import { describe, expect, it } from 'vitest'
import type { CompareAnswer, CompareDriverClient } from '../src/shared/compare'
import { createCompareRun } from '../src/renderer/compare/run-state'

const IDS = ['gemini', 'claude', 'copilot']

type Script = Record<string, Array<CompareAnswer | 'hang'>>

function fakeDriver(script: Script) {
  const calls: string[] = []
  const prompts: string[] = []
  const driver: CompareDriverClient = {
    detect: async () => ({ installed: true, path: '/x/ego-browser' }),
    ask(siteId, prompt, signal) {
      calls.push(siteId)
      prompts.push(prompt)
      const next = script[siteId]?.shift() ?? { ok: false, reason: 'no script' }
      if (next === 'hang')
        return new Promise((resolve) =>
          signal.addEventListener('abort', () => resolve({ ok: false, reason: 'stopped' })),
        )
      return Promise.resolve(next)
    },
  }
  return { driver, calls, prompts }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('compare run state machine', () => {
  it('asks every engine with the same prompt; each fails or succeeds on its own', async () => {
    const { driver, prompts } = fakeDriver({
      gemini: [{ ok: true, text: 'Sure, here you go:\nGemini text' }],
      claude: [{ ok: false, reason: 'not signed in' }],
      copilot: [{ ok: true, text: 'Copilot text' }],
    })
    const integrated: string[][] = []
    const run = createCompareRun({
      driver,
      engineIds: IDS,
      integrate: async (answers) => {
        integrated.push(answers.map((a) => a.id))
        return { ok: true, text: 'Merged' }
      },
    })
    run.start('PROMPT', true)
    expect(run.getState().engines.map((e) => e.status)).toEqual(['running', 'running', 'running'])
    await flush()
    const s = run.getState()
    expect(prompts).toEqual(['PROMPT', 'PROMPT', 'PROMPT'])
    expect(s.engines[0]).toMatchObject({ status: 'done', text: 'Gemini text' })
    expect(s.engines[1]).toMatchObject({ status: 'failed', reason: 'not signed in' })
    expect(s.engines[2]).toMatchObject({ status: 'done', text: 'Copilot text' })
    // auto integration ran once, over the two finished answers
    expect(integrated).toEqual([['gemini', 'copilot']])
    expect(s.integrate).toEqual({ status: 'done', text: 'Merged' })
  })

  it('retry re-asks only that engine and re-integrates', async () => {
    const { driver, calls } = fakeDriver({
      gemini: [{ ok: true, text: 'G' }],
      claude: [
        { ok: false, reason: 'timeout' },
        { ok: true, text: 'C' },
      ],
      copilot: [{ ok: true, text: 'P' }],
    })
    let integrations = 0
    const run = createCompareRun({
      driver,
      engineIds: IDS,
      integrate: async (a) => {
        integrations++
        return { ok: true, text: a.map((x) => x.text).join('+') }
      },
    })
    run.start('p', true)
    await flush()
    run.retry('gemini') // done engines cannot be retried
    expect(calls).toEqual(['gemini', 'claude', 'copilot'])
    run.retry('claude')
    await flush()
    expect(calls).toEqual(['gemini', 'claude', 'copilot', 'claude'])
    expect(run.getState().engines[1]).toMatchObject({ status: 'done', text: 'C' })
    expect(integrations).toBe(2)
    expect(run.getState().integrate.text).toBe('G+C+P')
  })

  it('without auto integrate nothing is integrated until asked', async () => {
    const { driver } = fakeDriver({ gemini: [{ ok: true, text: 'G' }] })
    let n = 0
    const run = createCompareRun({
      driver,
      engineIds: ['gemini'],
      integrate: async () => (n++, { ok: true, text: 'M' }),
    })
    run.start('p', false)
    await flush()
    expect(n).toBe(0)
    run.integrateNow()
    await flush()
    expect(n).toBe(1)
    expect(run.getState().integrate.status).toBe('done')
  })

  it('no integration when every engine failed; a failing integration is reported', async () => {
    const { driver } = fakeDriver({ gemini: [{ ok: false, reason: 'x' }] })
    let n = 0
    const run = createCompareRun({
      driver,
      engineIds: ['gemini'],
      integrate: async () => (n++, { ok: false, reason: 'blocked' }),
    })
    run.start('p', true)
    await flush()
    expect(n).toBe(0)
    const { driver: d2 } = fakeDriver({ gemini: [{ ok: true, text: 'G' }] })
    const run2 = createCompareRun({
      driver: d2,
      engineIds: ['gemini'],
      integrate: async () => ({ ok: false, reason: 'blocked' }),
    })
    run2.start('p', true)
    await flush()
    expect(run2.getState().integrate).toEqual({ status: 'failed', reason: 'blocked' })
  })

  it('stop aborts running engines and marks the rest stopped; late answers are ignored', async () => {
    const { driver } = fakeDriver({ gemini: ['hang'], claude: ['hang'], copilot: ['hang'] })
    const run = createCompareRun({
      driver,
      engineIds: IDS,
      integrate: async () => ({ ok: true, text: 'M' }),
      concurrency: 1,
    })
    run.start('p', true)
    expect(run.getState().engines.map((e) => e.status)).toEqual(['running', 'waiting', 'waiting'])
    run.stop()
    await flush()
    expect(run.getState().engines.map((e) => e.status)).toEqual(['stopped', 'stopped', 'stopped'])
    expect(run.getState().integrate.status).toBe('idle')
  })

  it('an engine that cannot chat is skipped quietly; the others still answer and are integrated', async () => {
    const { driver } = fakeDriver({
      gemini: [{ ok: true, text: 'G' }],
      claude: [{ ok: false, reason: 'login-wall' }],
      copilot: [{ ok: false, reason: 'no-prompt-box' }],
    })
    const seen: string[][] = []
    const run = createCompareRun({
      driver,
      engineIds: IDS,
      integrate: async (a) => (seen.push(a.map((x) => x.id)), { ok: true, text: 'M' }),
    })
    run.start('p', true)
    await flush()
    const s = run.getState()
    expect(s.engines.map((e) => e.status)).toEqual(['done', 'skipped', 'skipped'])
    expect(s.engines[1]!.reason).toBeUndefined()
    expect(seen).toEqual([['gemini']])
  })

  it('needs-user is its own state and is not retried by itself; a manual retry may succeed', async () => {
    const { driver, calls } = fakeDriver({
      gemini: [
        { ok: false, reason: 'needs-user' },
        { ok: true, text: 'G' },
      ],
    })
    const run = createCompareRun({
      driver,
      engineIds: ['gemini'],
      integrate: async () => ({ ok: true, text: 'M' }),
    })
    run.start('p', true)
    await flush()
    expect(run.getState().engines[0]!.status).toBe('needsUser')
    expect(calls).toEqual(['gemini'])
    run.retry('gemini')
    await flush()
    expect(run.getState().engines[0]).toMatchObject({ status: 'done', text: 'G' })
  })

  it('when no engine answered nothing is integrated and the run is settled', async () => {
    const { driver } = fakeDriver({
      gemini: [{ ok: false, reason: 'login-wall' }],
      claude: [{ ok: false, reason: 'timeout' }],
    })
    let n = 0
    const run = createCompareRun({
      driver,
      engineIds: ['gemini', 'claude'],
      integrate: async () => (n++, { ok: true, text: 'M' }),
    })
    run.start('p', true)
    await flush()
    expect(run.getState().engines.map((e) => e.status)).toEqual(['skipped', 'failed'])
    expect(n).toBe(0)
    expect(run.getState().integrate.status).toBe('idle')
  })

  it('an empty cleaned answer counts as a failure', async () => {
    const { driver } = fakeDriver({ gemini: [{ ok: true, text: '```\n```' }] })
    const run = createCompareRun({
      driver,
      engineIds: ['gemini'],
      integrate: async () => ({ ok: true, text: 'M' }),
    })
    run.start('p', false)
    await flush()
    expect(run.getState().engines[0]!.status).toBe('failed')
  })
})
