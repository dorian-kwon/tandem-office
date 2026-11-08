/**
 * One comparison advances in paragraph order. Enabled web engines start together for a unit;
 * all of their answers settle before app AI integration and the next unit. A single
 * engine never handles two units concurrently. Browser, IPC and editor details stay in deps.
 *
 * Blocked engines remain excluded without retries; their peers finish normally. Pause collects
 * the current unit's in-flight answers and holds before starting more work. Stop aborts every
 * active request and ignores late replies. Each batch handles at most `batchSize` units.
 */
import { isBlockReason, type CompareAnswer, type CompareDriverClient } from '../../shared/compare'
import { cleanCandidate } from './prompts'

/** units asked per run (and per "continue") */
export const COMPARE_BATCH_SIZE = 20
/** the pause between consecutive units (for each engine) */
export const COMPARE_PACE_MS = 4000

export type EngineStatus = 'waiting' | 'running' | 'done' | 'failed' | 'stopped' | 'blocked'

export interface EngineResult {
  status: EngineStatus
  /** the single cleaned answer */
  text?: string
  /** why it failed or was blocked (a block code or a short diagnostic) */
  reason?: string
}

export interface IntegrateState {
  status: 'idle' | 'running' | 'done' | 'failed'
  text?: string
  reason?: string
}

export interface UnitResult {
  id: string
  /** the unit has been handled by this run (all its engines answered, failed or were blocked) */
  visited: boolean
  engines: Record<string, EngineResult>
  integrate: IntegrateState
  applied: boolean
}

export type Phase = 'idle' | 'running' | 'paused' | 'stopped' | 'batchDone' | 'done' | 'allBlocked'

export interface RunState {
  phase: Phase
  units: UnitResult[]
  /** enabled engine ids in stable display/candidate order */
  engines: string[]
  /** engine id to the block code that blocked it */
  blocked: Record<string, string>
  /** index of the unit being (or next to be) handled */
  next: number
  /** the batch: units `batchStart` to `batchEnd` (exclusive) */
  batchStart: number
  batchEnd: number
  total: number
}

export interface RunnerUnit {
  id: string
  /** the text asked about */
  text: string
  /** the Korean original, '' when there is none */
  korean: string
}

export interface IntegrationCandidate {
  id: string
  text: string
}

export interface RunnerDeps {
  driver: CompareDriverClient
  /** the prompt of one unit (pure; mode depends on the unit's original) */
  promptFor(unit: RunnerUnit): string
  /** Retry only while the original text range is still valid. */
  canRetry?(unit: RunnerUnit): boolean
  /** the app's own AI over the answers of one unit */
  integrate(
    unit: RunnerUnit,
    answers: IntegrationCandidate[],
    signal: AbortSignal,
  ): Promise<CompareAnswer>
  paceMs?: number
  batchSize?: number
  /** waits `ms`; generation guards prevent further work after stop (a fake in tests) */
  sleep?(ms: number): Promise<void>
}

export interface Runner {
  getState(): RunState
  subscribe(listener: () => void): () => void
  /** begin (or restart) a run over `units` with these engines */
  start(units: RunnerUnit[], engines: string[], autoIntegrate: boolean): void
  pause(): void
  resume(): void
  stop(): void
  /** after a finished batch: the next `batchSize` units */
  continueNext(): void
  /** ask one engine again about one unit (not while running, never a blocked engine) */
  retry(unitId: string, engineId: string): void
  retryFailed(): void
  /** integrate one unit now */
  integrateNow(unitId: string): void
  setAutoIntegrate(on: boolean): void
  markApplied(unitId: string): void
}

const settledStatus = (s: EngineStatus): boolean => s !== 'waiting' && s !== 'running'

export function createRunner(deps: RunnerDeps): Runner {
  const pace = deps.paceMs ?? COMPARE_PACE_MS
  const batchSize = Math.max(1, deps.batchSize ?? COMPARE_BATCH_SIZE)
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const listeners = new Set<() => void>()
  let state: RunState = idleState()
  let units: RunnerUnit[] = []
  let auto = true
  let generation = 0
  const active = new Set<AbortController>()
  let resumeGate: (() => void) | null = null
  let calledOnce = false

  function idleState(): RunState {
    return {
      phase: 'idle',
      units: [],
      engines: [],
      blocked: {},
      next: 0,
      batchStart: 0,
      batchEnd: 0,
      total: 0,
    }
  }
  function emit(next: RunState): void {
    state = next
    for (const l of [...listeners]) l()
  }
  function patchUnit(id: string, patch: (u: UnitResult) => UnitResult): void {
    emit({ ...state, units: state.units.map((u) => (u.id === id ? patch(u) : u)) })
  }
  function setEngine(id: string, engine: string, result: EngineResult): void {
    patchUnit(id, (u) => ({ ...u, engines: { ...u.engines, [engine]: result } }))
  }
  const unitOf = (id: string): RunnerUnit | undefined => units.find((u) => u.id === id)
  const resultOf = (id: string): UnitResult | undefined => state.units.find((u) => u.id === id)

  function candidatesOf(result: UnitResult): IntegrationCandidate[] {
    const out: IntegrationCandidate[] = []
    for (const engine of state.engines) {
      const e = result.engines[engine]
      if (e?.status !== 'done') continue
      if (e.text) out.push({ id: engine, text: e.text })
    }
    return out
  }

  /** waits while paused; false when the run was stopped or replaced */
  async function gate(gen: number): Promise<boolean> {
    while (gen === generation && state.phase === 'paused') {
      await new Promise<void>((resolve) => (resumeGate = resolve))
    }
    return gen === generation && state.phase === 'running'
  }

  async function askEngine(unit: RunnerUnit, engine: string, gen: number): Promise<void> {
    if (gen !== generation) return
    setEngine(unit.id, engine, { status: 'running' })
    const controller = new AbortController()
    active.add(controller)
    let answer: CompareAnswer
    try {
      answer = await deps.driver.ask(engine, deps.promptFor(unit), controller.signal)
    } catch (error) {
      answer = { ok: false, reason: String(error).slice(0, 200) }
    }
    active.delete(controller)
    if (gen !== generation) return
    if (controller.signal.aborted) {
      setEngine(unit.id, engine, { status: 'stopped' })
    } else if (answer.ok) {
      const text = cleanCandidate(answer.text)
      setEngine(
        unit.id,
        engine,
        text ? { status: 'done', text } : { status: 'failed', reason: 'the answer was empty' },
      )
    } else if (isBlockReason(answer.reason)) {
      const reason = answer.reason
      emit({
        ...state,
        blocked: { ...state.blocked, [engine]: reason },
        units: state.units.map((u) =>
          u.engines[engine]?.status === 'waiting'
            ? { ...u, engines: { ...u.engines, [engine]: { status: 'blocked', reason } } }
            : u,
        ),
      })
      setEngine(unit.id, engine, { status: 'blocked', reason: answer.reason })
    } else {
      setEngine(unit.id, engine, { status: 'failed', reason: answer.reason })
    }
  }

  async function integrateUnit(unit: RunnerUnit, gen: number): Promise<void> {
    const result = resultOf(unit.id)
    const answers = result ? candidatesOf(result) : []
    if (answers.length === 0) {
      patchUnit(unit.id, (u) => ({
        ...u,
        integrate: { status: 'failed', reason: 'no-candidates' },
      }))
      return
    }
    patchUnit(unit.id, (u) => ({ ...u, integrate: { status: 'running' } }))
    const controller = new AbortController()
    active.add(controller)
    let reply: CompareAnswer
    try {
      reply = await deps.integrate(unit, answers, controller.signal)
    } catch (error) {
      reply = { ok: false, reason: String(error).slice(0, 200) }
    }
    active.delete(controller)
    if (gen !== generation) return
    if (reply.ok) {
      const text = cleanCandidate(reply.text)
      patchUnit(unit.id, (u) => ({
        ...u,
        integrate: text
          ? { status: 'done', text }
          : { status: 'failed', reason: 'the answer was empty' },
      }))
    } else {
      patchUnit(unit.id, (u) => ({ ...u, integrate: { status: 'failed', reason: reply.reason } }))
    }
  }

  async function runBatch(gen: number): Promise<void> {
    while (state.next < state.batchEnd) {
      if (!(await gate(gen))) return
      if (calledOnce) {
        await sleep(pace)
        if (!(await gate(gen))) return
      }
      const unit = units[state.next]!
      calledOnce = true
      await Promise.all(
        state.engines.map((engine) => {
          if (state.blocked[engine]) {
            setEngine(unit.id, engine, { status: 'blocked', reason: state.blocked[engine]! })
            return Promise.resolve()
          }
          return askEngine(unit, engine, gen)
        }),
      )
      if (gen !== generation) return
      if (state.engines.every((e) => state.blocked[e])) {
        patchUnit(unit.id, (u) => ({ ...u, visited: true }))
        emit({ ...state, phase: 'allBlocked' })
        return
      }
      if (!(await gate(gen))) return
      if (auto) await integrateUnit(unit, gen)
      if (!(await gate(gen))) return
      patchUnit(unit.id, (u) => ({ ...u, visited: true }))
      emit({ ...state, next: state.next + 1 })
    }
    emit({ ...state, phase: state.batchEnd >= state.total ? 'done' : 'batchDone' })
  }

  function abortActive(): void {
    for (const controller of [...active]) controller.abort()
    active.clear()
  }

  function retryPairs(
    pairs: Array<{ unitId: string; engineId: string }>,
    allowStopped = false,
  ): void {
    if (!['stopped', 'batchDone', 'done', 'allBlocked'].includes(state.phase)) return
    const eligible = (unit: RunnerUnit, id: string): boolean => {
      const result = resultOf(unit.id)
      const status = result?.engines[id]?.status
      return (
        !result?.applied &&
        !state.blocked[id] &&
        (status === 'failed' || (allowStopped && status === 'stopped')) &&
        (deps.canRetry?.(unit) ?? true)
      )
    }
    const queued = units
      .map((unit) => ({
        unit,
        engines: [
          ...new Set(pairs.filter((p) => p.unitId === unit.id).map((p) => p.engineId)),
        ].filter((id) => eligible(unit, id)),
      }))
      .filter((item) => item.engines.length)
    if (!queued.length) return
    const phase = state.phase
    const gen = ++generation
    emit({ ...state, phase: 'running' })
    void (async () => {
      let attempted = false
      for (const { unit, engines } of queued) {
        if (!(await gate(gen))) return
        if (attempted) {
          await sleep(pace)
          if (!(await gate(gen))) return
        }
        const current = engines.filter((id) => eligible(unit, id))
        if (!current.length) continue
        attempted = true
        const previousFinal = resultOf(unit.id)?.integrate ?? { status: 'idle' as const }
        if (auto) patchUnit(unit.id, (u) => ({ ...u, integrate: { status: 'idle' } }))
        await Promise.all(current.map((id) => askEngine(unit, id, gen)))
        if (gen !== generation) return
        if (!(await gate(gen))) return
        if (auto) {
          if (current.some((id) => resultOf(unit.id)?.engines[id]?.status === 'done'))
            await integrateUnit(unit, gen)
          else patchUnit(unit.id, (u) => ({ ...u, integrate: previousFinal }))
        }
        if (!(await gate(gen))) return
      }
      if (await gate(gen)) emit({ ...state, phase })
    })()
  }

  function launch(): void {
    const gen = ++generation
    calledOnce = false
    void runBatch(gen)
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start(nextUnits, requestedEngines, autoIntegrate) {
      const engines = [...new Set(requestedEngines)]
      abortActive()
      resumeGate?.()
      resumeGate = null
      generation++
      units = nextUnits
      auto = autoIntegrate
      emit({
        phase: nextUnits.length > 0 && engines.length > 0 ? 'running' : 'done',
        units: nextUnits.map((u) => ({
          id: u.id,
          visited: false,
          engines: Object.fromEntries(engines.map((e) => [e, { status: 'waiting' as const }])),
          integrate: { status: 'idle' },
          applied: false,
        })),
        engines,
        blocked: {},
        next: 0,
        batchStart: 0,
        batchEnd: Math.min(batchSize, nextUnits.length),
        total: nextUnits.length,
      })
      if (state.phase === 'running') launch()
    },
    pause() {
      if (state.phase === 'running') emit({ ...state, phase: 'paused' })
    },
    resume() {
      if (state.phase !== 'paused') return
      emit({ ...state, phase: 'running' })
      resumeGate?.()
      resumeGate = null
    },
    stop() {
      if (state.phase !== 'running' && state.phase !== 'paused') return
      generation++
      abortActive()
      resumeGate?.()
      resumeGate = null
      emit({
        ...state,
        phase: 'stopped',
        units: state.units.map((u) => ({
          ...u,
          engines: Object.fromEntries(
            Object.entries(u.engines).map(([k, e]) => [
              k,
              settledStatus(e.status) ? e : { status: 'stopped' as const },
            ]),
          ),
          integrate: u.integrate.status === 'running' ? { status: 'idle' } : u.integrate,
        })),
      })
    },
    continueNext() {
      if (state.phase !== 'batchDone') return
      emit({
        ...state,
        phase: 'running',
        batchStart: state.next,
        batchEnd: Math.min(state.next + batchSize, state.total),
      })
      launch()
    },
    retry(unitId, engineId) {
      retryPairs([{ unitId, engineId }], true)
    },
    retryFailed() {
      retryPairs(
        state.units.flatMap((unit) =>
          Object.entries(unit.engines)
            .filter(([, result]) => result.status === 'failed')
            .map(([engineId]) => ({ unitId: unit.id, engineId })),
        ),
      )
    },
    integrateNow(unitId) {
      const unit = unitOf(unitId)
      if (
        !unit ||
        resultOf(unitId)?.applied ||
        !(deps.canRetry?.(unit) ?? true) ||
        ['idle', 'running', 'paused'].includes(state.phase)
      )
        return
      const phase = state.phase
      const gen = generation
      emit({ ...state, phase: 'running' })
      void integrateUnit(unit, gen).then(async () => {
        if (await gate(gen)) emit({ ...state, phase })
      })
    },
    setAutoIntegrate(on) {
      auto = on
    },
    markApplied(unitId) {
      patchUnit(unitId, (u) => ({ ...u, applied: true }))
    },
  }
}
