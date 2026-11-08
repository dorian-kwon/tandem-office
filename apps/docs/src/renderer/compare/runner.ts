/**
 * The scheduler of one comparison: the engines (Copilot, Grok, ...) are asked about the units
 * (one paragraph, or the selection) strictly one at a time, in unit order and within a unit in
 * engine order, with a pause between calls so the sites are not hammered. It knows nothing about
 * ego lite, IPC, React or the editor: the driver, the prompt builder and the integration step are
 * passed in, so tests use fakes and a fake clock.
 *
 * Rules:
 * - an engine that reports a block (login wall, no prompt box, a hand-over to the person, a CAPTCHA
 *   page) is BLOCKED for the rest of the run: shown as blocked, never asked again, never worked
 *   around. The other engines go on; when every enabled engine is blocked the run stops;
 * - a run asks at most `batchSize` units; "continue" asks the next batch;
 * - pause takes effect between calls (the call in flight finishes), resume goes on, stop aborts the
 *   call in flight (the driver kills its process tree) and ends the run.
 */
import {
  isBlockReason,
  type CompareAnswer,
  type CompareDriverClient,
} from '../../shared/compare'
import { cleanCandidate, splitAnswer, type CandidateKind } from './prompts'

/** units asked per run (and per "continue") */
export const COMPARE_BATCH_SIZE = 20
/** the pause between two calls to the web engines */
export const COMPARE_PACE_MS = 4000

export type EngineStatus = 'waiting' | 'running' | 'done' | 'failed' | 'stopped' | 'blocked'

export interface EngineResult {
  status: EngineStatus
  /** the cleaned answer (the polished text when two sections were asked for) */
  text?: string
  /** the site's own fresh translation, when asked for and given */
  retranslation?: string
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
  /** engines asked in this run, in order */
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
  kind: CandidateKind
  text: string
}

export interface RunnerDeps {
  driver: CompareDriverClient
  /** the prompt of one unit (pure; mode depends on the unit's original) */
  promptFor(unit: RunnerUnit): string
  /** whether the prompt of this unit asks for a re-translation (replies are then split by markers) */
  retranslateFor(unit: RunnerUnit): boolean
  /** the app's own AI over the answers of one unit */
  integrate(unit: RunnerUnit, answers: IntegrationCandidate[]): Promise<CompareAnswer>
  paceMs?: number
  batchSize?: number
  /** waits `ms`; stop ends the wait early (a fake in tests) */
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
  let abort: AbortController | null = null
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
      if (e.text) out.push({ id: engine, kind: 'polished', text: e.text })
      if (e.retranslation) out.push({ id: engine, kind: 'retranslation', text: e.retranslation })
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
    setEngine(unit.id, engine, { status: 'running' })
    const controller = new AbortController()
    abort = controller
    let answer: CompareAnswer
    try {
      answer = await deps.driver.ask(engine, deps.promptFor(unit), controller.signal)
    } catch (error) {
      answer = { ok: false, reason: String(error).slice(0, 200) }
    }
    if (abort === controller) abort = null
    if (gen !== generation) return
    if (controller.signal.aborted) {
      setEngine(unit.id, engine, { status: 'stopped' })
    } else if (answer.ok) {
      const { polished, retranslation } = splitAnswer(answer.text, deps.retranslateFor(unit))
      if (polished || retranslation) {
        setEngine(unit.id, engine, {
          status: 'done',
          ...(polished ? { text: polished } : {}),
          ...(retranslation ? { retranslation } : {}),
        })
      } else setEngine(unit.id, engine, { status: 'failed', reason: 'the answer was empty' })
    } else if (isBlockReason(answer.reason)) {
      emit({ ...state, blocked: { ...state.blocked, [engine]: answer.reason } })
      setEngine(unit.id, engine, { status: 'blocked', reason: answer.reason })
    } else {
      setEngine(unit.id, engine, { status: 'failed', reason: answer.reason })
    }
  }

  async function integrateUnit(unit: RunnerUnit, gen: number): Promise<void> {
    const result = resultOf(unit.id)
    const answers = result ? candidatesOf(result) : []
    if (answers.length === 0) return
    patchUnit(unit.id, (u) => ({ ...u, integrate: { status: 'running' } }))
    let reply: CompareAnswer
    try {
      reply = await deps.integrate(unit, answers)
    } catch (error) {
      reply = { ok: false, reason: String(error).slice(0, 200) }
    }
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
      const unit = units[state.next]!
      for (const engine of state.engines) {
        if (state.blocked[engine]) {
          setEngine(unit.id, engine, { status: 'blocked', reason: state.blocked[engine]! })
          continue
        }
        if (!(await gate(gen))) return
        if (calledOnce) {
          await sleep(pace)
          if (!(await gate(gen))) return
        }
        calledOnce = true
        await askEngine(unit, engine, gen)
        if (gen !== generation || state.phase !== 'running') {
          if (gen === generation && state.phase === 'paused') continue
          return
        }
      }
      if (state.engines.every((e) => state.blocked[e])) {
        patchUnit(unit.id, (u) => ({ ...u, visited: true }))
        emit({ ...state, phase: 'allBlocked' })
        return
      }
      if (auto && (await gate(gen))) await integrateUnit(unit, gen)
      if (gen !== generation) return
      patchUnit(unit.id, (u) => ({ ...u, visited: true }))
      emit({ ...state, next: state.next + 1 })
    }
    emit({ ...state, phase: state.batchEnd >= state.total ? 'done' : 'batchDone' })
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
    start(nextUnits, engines, autoIntegrate) {
      abort?.abort()
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
      abort?.abort()
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
      const unit = unitOf(unitId)
      const e = resultOf(unitId)?.engines[engineId]
      const idle = ['paused', 'stopped', 'batchDone', 'done', 'allBlocked'].includes(state.phase)
      if (!unit || !e || !idle || state.blocked[engineId]) return
      if (e.status !== 'failed' && e.status !== 'stopped') return
      const gen = generation
      const before = state
      emit({ ...state, phase: 'running' })
      void askEngine(unit, engineId, gen).then(() => {
        if (gen === generation && state.phase === 'running') emit({ ...state, phase: before.phase })
      })
    },
    integrateNow(unitId) {
      const unit = unitOf(unitId)
      if (unit && state.phase !== 'running') void integrateUnit(unit, generation)
    },
    setAutoIntegrate(on) {
      auto = on
    },
    markApplied(unitId) {
      patchUnit(unitId, (u) => ({ ...u, applied: true }))
    },
  }
}
