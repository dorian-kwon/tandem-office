/**
 * The state machine of one comparison: three (or however many the site table
 * lists) web engines that can fail independently, a retry per engine, and the
 * integration step. It knows nothing about ego lite, IPC or React: the driver
 * and the integration step are passed in, so tests use fakes.
 */
import {
  COMPARE_NEEDS_USER,
  isSkipReason,
  type CompareAnswer,
  type CompareDriverClient,
} from '../../shared/compare'
import { cleanCandidate, splitAnswer, type CandidateKind } from './prompts'

/**
 * `skipped`: chatting is impossible there (login wall, redirect to a login page, no prompt box);
 * the engine is left out quietly (no error).
 * `needsUser`: ego lite gave the space to the person (a browser prompt); nothing is retried
 * around it, the person handles it and may press Retry.
 */
export type EngineStatus =
  'waiting' | 'running' | 'done' | 'failed' | 'stopped' | 'skipped' | 'needsUser'

export interface EngineState {
  id: string
  status: EngineStatus
  /** the cleaned polished English, when done (absent when the reply held only a re-translation) */
  text?: string
  /** the site's own fresh translation of the Korean, when asked for and given */
  retranslation?: string
  /** why it failed, when failed */
  reason?: string
}

export interface IntegrateState {
  status: 'idle' | 'running' | 'done' | 'failed'
  text?: string
  reason?: string
}

export interface CompareState {
  started: boolean
  engines: EngineState[]
  integrate: IntegrateState
}

/** one finished text handed to the integration step */
export interface IntegrationCandidate {
  id: string
  kind: CandidateKind
  text: string
}

export interface CompareRunDeps {
  driver: CompareDriverClient
  /** engine ids in display order (from the site table) */
  engineIds: readonly string[]
  /** the integration step: the app's own AI over the finished answers */
  integrate(answers: IntegrationCandidate[]): Promise<CompareAnswer>
  /** engines asked at the same time */
  concurrency?: number
}

export interface CompareRun {
  getState(): CompareState
  subscribe(listener: () => void): () => void
  /** `retranslate`: the prompt also asks for a fresh translation, and the replies are split by markers */
  start(prompt: string, autoIntegrate: boolean, retranslate?: boolean): void
  retry(id: string): void
  stop(): void
  setAutoIntegrate(on: boolean): void
  integrateNow(): void
}

/** how many web engines are asked at once */
export const COMPARE_CONCURRENCY = 3

export function createCompareRun(deps: CompareRunDeps): CompareRun {
  const concurrency = Math.max(1, deps.concurrency ?? COMPARE_CONCURRENCY)
  let state: CompareState = initial()
  let prompt = ''
  let retranslate = false
  let auto = true
  let generation = 0
  let integrateToken = 0
  let integratedFor = ''
  const aborts = new Map<string, AbortController>()
  const queue: string[] = []
  let active = 0
  const listeners = new Set<() => void>()

  function initial(): CompareState {
    return {
      started: false,
      engines: deps.engineIds.map((id) => ({ id, status: 'waiting' })),
      integrate: { status: 'idle' },
    }
  }
  function emit(next: CompareState): void {
    state = next
    for (const listener of [...listeners]) listener()
  }
  function setEngine(id: string, patch: Partial<EngineState>): void {
    emit({
      ...state,
      engines: state.engines.map((e) =>
        e.id === id ? { id, status: patch.status ?? e.status, ...pick(patch) } : e,
      ),
    })
  }
  const pick = (patch: Partial<EngineState>): Partial<EngineState> => {
    const out: Partial<EngineState> = {}
    if (patch.text !== undefined) out.text = patch.text
    if (patch.retranslation !== undefined) out.retranslation = patch.retranslation
    if (patch.reason !== undefined) out.reason = patch.reason
    return out
  }
  const engine = (id: string): EngineState | undefined => state.engines.find((e) => e.id === id)
  const settled = (): boolean =>
    state.engines.every((e) => e.status !== 'waiting' && e.status !== 'running')
  const doneAnswers = (): IntegrationCandidate[] =>
    state.engines.flatMap((e): IntegrationCandidate[] =>
      e.status === 'done'
        ? [
            ...(e.text ? [{ id: e.id, kind: 'polished' as const, text: e.text }] : []),
            ...(e.retranslation
              ? [{ id: e.id, kind: 'retranslation' as const, text: e.retranslation }]
              : []),
          ]
        : [],
    )

  async function runEngine(id: string, gen: number): Promise<void> {
    const controller = new AbortController()
    aborts.set(id, controller)
    setEngine(id, { status: 'running' })
    let answer: CompareAnswer
    try {
      answer = await deps.driver.ask(id, prompt, controller.signal)
    } catch (error) {
      answer = { ok: false, reason: String(error).slice(0, 200) }
    }
    if (gen !== generation || aborts.get(id) !== controller) return
    aborts.delete(id)
    if (controller.signal.aborted) {
      setEngine(id, { status: 'stopped' })
    } else if (answer.ok) {
      const { polished, retranslation } = splitAnswer(answer.text, retranslate)
      if (polished || retranslation) {
        setEngine(id, {
          status: 'done',
          ...(polished ? { text: polished } : {}),
          ...(retranslation ? { retranslation } : {}),
        })
      } else setEngine(id, { status: 'failed', reason: 'the answer was empty' })
    } else if (isSkipReason(answer.reason)) {
      setEngine(id, { status: 'skipped' })
    } else if (answer.reason === COMPARE_NEEDS_USER) {
      setEngine(id, { status: 'needsUser' })
    } else {
      setEngine(id, { status: 'failed', reason: answer.reason })
    }
  }

  function pump(gen: number): void {
    while (active < concurrency && queue.length > 0) {
      const id = queue.shift()!
      active++
      void runEngine(id, gen).finally(() => {
        if (gen !== generation) return
        active--
        pump(gen)
        afterSettle()
      })
    }
  }

  function afterSettle(): void {
    if (auto && settled() && doneAnswers().length > 0) void integrate(false)
  }

  async function integrate(force: boolean): Promise<void> {
    const answers = doneAnswers()
    if (answers.length === 0) return
    const signature = JSON.stringify(answers)
    if (!force && signature === integratedFor && state.integrate.status !== 'failed') return
    integratedFor = signature
    const token = ++integrateToken
    emit({ ...state, integrate: { status: 'running' } })
    let result: CompareAnswer
    try {
      result = await deps.integrate(answers)
    } catch (error) {
      result = { ok: false, reason: String(error).slice(0, 200) }
    }
    if (token !== integrateToken) return
    if (result.ok) {
      const text = cleanCandidate(result.text)
      emit({
        ...state,
        integrate: text
          ? { status: 'done', text }
          : { status: 'failed', reason: 'the answer was empty' },
      })
    } else {
      emit({ ...state, integrate: { status: 'failed', reason: result.reason } })
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start(nextPrompt, autoIntegrate, withRetranslation = false) {
      generation++
      integrateToken++
      for (const controller of aborts.values()) controller.abort()
      aborts.clear()
      queue.length = 0
      active = 0
      integratedFor = ''
      prompt = nextPrompt
      auto = autoIntegrate
      retranslate = withRetranslation
      emit({ ...initial(), started: true })
      queue.push(...deps.engineIds)
      pump(generation)
    },
    retry(id) {
      const current = engine(id)
      const retryable = ['failed', 'stopped', 'skipped', 'needsUser']
      if (!current || !retryable.includes(current.status)) return
      const gen = generation
      active++
      setEngine(id, { status: 'running' })
      void runEngine(id, gen).finally(() => {
        if (gen !== generation) return
        active--
        pump(gen)
        afterSettle()
      })
    },
    stop() {
      const gen = generation
      queue.length = 0
      for (const controller of aborts.values()) controller.abort()
      emit({
        ...state,
        engines: state.engines.map((e) =>
          e.status === 'waiting' || e.status === 'running'
            ? { id: e.id, status: 'stopped' as const }
            : e,
        ),
      })
      // a run in flight answers late and is ignored: its controller is gone
      aborts.clear()
      active = 0
      generation = gen + 1
    },
    setAutoIntegrate(on) {
      auto = on
      if (on) afterSettle()
    },
    integrateNow() {
      void integrate(true)
    },
  }
}
