import type {
  ProjectBatchActivity,
  ProjectBatchItem,
  ProjectBatchSnapshot,
} from '../../shared/project-batch'
import { TranslateIpcError } from '../../shared/translate-api'

export interface ProjectBatchEditorRequest {
  dir: string
  file: string
  outputPath: string
  sourceLang: string
  targetLang: string
  signal: AbortSignal
  report: (update: ProjectBatchActivity) => void
}

/** A single editor works at a time, including its save and teardown. */
export class ProjectBatchQueue {
  private active?: { dir: string; controller: AbortController; owner: number }
  private readonly projects = new Map<string, ProjectBatchSnapshot>()

  constructor(private readonly changed: (value: ProjectBatchSnapshot) => void) {}

  busy(dir: string): boolean {
    return this.active?.dir === dir
  }

  status(dir: string): ProjectBatchSnapshot | null {
    const state = this.projects.get(dir)
    return state ? structuredClone(state) : null
  }

  forget(dir: string): void {
    if (!this.busy(dir)) this.projects.delete(dir)
  }

  stopOwner(owner: number): void {
    if (this.active?.owner === owner) this.stop(this.active.dir)
  }

  stop(dir: string): void {
    if (!this.active || this.active.dir !== dir) return
    const state = this.projects.get(dir)!
    state.stopping = true
    this.active.controller.abort()
    this.emit(state)
  }

  start(
    dir: string,
    files: string[],
    owner: number,
    run: (
      file: string,
      signal: AbortSignal,
      progress: ProjectBatchEditorRequest['report'],
    ) => Promise<string | void>,
    retry: boolean,
  ): ProjectBatchSnapshot {
    if (this.active)
      throw new TranslateIpcError('TRANSLATE_BUSY', 'A project translation is already running.')
    const wanted = new Set(files)
    const previous = retry ? this.projects.get(dir)?.items : undefined
    if (retry) {
      const unfinished = new Set(
        previous
          ?.filter((item) => item.state === 'failed' || item.state === 'stopped')
          .map((item) => item.file),
      )
      for (const file of wanted) if (!unfinished.has(file)) wanted.delete(file)
      if (!wanted.size)
        throw new TranslateIpcError(
          'INVALID_ARGUMENT',
          'There are no unfinished documents to retry.',
        )
    }
    const items: ProjectBatchItem[] = previous
      ? previous.map((item) =>
          wanted.has(item.file) ? { file: item.file, state: 'waiting' } : item,
        )
      : []
    const kept = new Set(items.map((item) => item.file))
    for (const file of wanted) if (!kept.has(file)) items.push({ file, state: 'waiting' })
    const state: ProjectBatchSnapshot = { dir, running: true, stopping: false, items }
    const controller = new AbortController()
    this.active = { dir, controller, owner }
    this.projects.set(dir, state)
    void this.run(state, controller.signal, wanted, run)
    return this.status(dir)!
  }

  private emit(state: ProjectBatchSnapshot): void {
    this.changed(state)
  }

  private async run(
    state: ProjectBatchSnapshot,
    signal: AbortSignal,
    wanted: Set<string>,
    run: (
      file: string,
      signal: AbortSignal,
      progress: ProjectBatchEditorRequest['report'],
    ) => Promise<string | void>,
  ): Promise<void> {
    try {
      for (const item of state.items) {
        if (!wanted.has(item.file)) continue
        if (signal.aborted) {
          item.state = 'stopped'
          continue
        }
        item.state = 'running'
        item.phase = 'opening'
        this.emit(state)
        let lastUpdate = 0
        let pending: ReturnType<typeof setTimeout> | undefined
        const flush = () => {
          clearTimeout(pending)
          pending = undefined
          lastUpdate = Date.now()
          this.emit(state)
        }
        try {
          const output = await run(item.file, signal, ({ phase, operations, done, total }) => {
            if (item.state !== 'running' || signal.aborted) return
            const changedPhase = phase !== undefined && phase !== item.phase
            if (changedPhase) {
              // Page recognition and text translation use different units.
              if (item.phase === 'ocr') {
                delete item.done
                delete item.total
              }
              item.phase = phase
            }
            if (operations !== undefined && Number.isSafeInteger(operations) && operations >= 0) {
              item.operations = Math.max(item.operations ?? 0, operations)
              // An ordinary edit may invalidate the earlier unit count.
              if (done === undefined || total === undefined) {
                delete item.done
                delete item.total
              }
            }
            if (
              total !== undefined &&
              done !== undefined &&
              Number.isSafeInteger(total) &&
              total > 0 &&
              Number.isSafeInteger(done) &&
              done >= 0
            ) {
              item.done = Math.min(done, total)
              item.total = total
            }
            const remaining = 250 - (Date.now() - lastUpdate)
            if (changedPhase || remaining <= 0) flush()
            else pending ??= setTimeout(flush, remaining)
          })
          if (output) item.output = output
          item.state = 'saved'
        } catch (err) {
          item.state = signal.aborted ? 'stopped' : 'failed'
          if (!signal.aborted)
            item.error = String(err instanceof Error ? err.message : err).slice(0, 320)
        } finally {
          clearTimeout(pending)
        }
      }
    } finally {
      this.active = undefined
      state.running = false
      state.stopping = false
      this.emit(state)
    }
  }
}
