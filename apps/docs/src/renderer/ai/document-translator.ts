import type {
  TranslationCommit,
  TranslationRange,
  TranslationUnit,
  TranslationUnitIndex,
} from './translation-units'

export interface DocumentTranslationSpec {
  targetLanguage: string
  sourceLanguage?: string
  provider: string
  model: string
  context?: string
  glossary?: string
  style?: string
  instructions?: string
  range?: TranslationRange
  includeNotes?: boolean
}

export interface DocumentTranslationRequest {
  spec: Readonly<DocumentTranslationSpec>
  units: readonly { readonly id: string; readonly segments: readonly string[] }[]
  signal: AbortSignal
}

export interface DocumentTranslationResult {
  /** Successfully committed units in this run, including cached output. */
  completed: number
  /** Cached output or unchanged post-commit receipts; overlaps completed. */
  reused: number
  failed: number
  stale: number
  skipped: number
  pending: number
  stopped: boolean
  issues: { id: string; status: 'failed' | 'stale' | 'skipped'; reason: string }[]
}

export interface DocumentTranslatorDependencies {
  index: TranslationUnitIndex
  request(request: DocumentTranslationRequest): Promise<string>
  /** Must resolve and apply atomically, then return the post-write unit. */
  commit(unit: TranslationUnit, segments: readonly string[]): TranslationCommit
  onBeforeCommit?(): void
  onProgress?(result: DocumentTranslationResult): void
  cacheLimit?: number
}

type Cached = { unit: TranslationUnit; segments?: readonly string[]; size: number }
type Work = {
  unit: TranslationUnit
  key: string
  state: 'waiting' | 'ready' | 'done'
  segments?: readonly string[]
  reused?: boolean
  error?: string
}

function sameSource(a: TranslationUnit, b: TranslationUnit): boolean {
  return (
    a.id === b.id &&
    a.version === b.version &&
    a.shape === b.shape &&
    a.segments.length === b.segments.length &&
    a.segments.every((s, i) => s === b.segments[i])
  )
}

function cloneUnit(u: TranslationUnit): TranslationUnit {
  return { ...u, segments: [...u.segments], address: { ...u.address } }
}

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}

function validateReply(
  text: string,
  units: readonly TranslationUnit[],
): Map<string, readonly string[]> {
  const value: unknown = JSON.parse(text)
  if (
    !exactKeys(value, ['translations']) ||
    !Array.isArray(value.translations) ||
    value.translations.length !== units.length
  ) {
    throw new Error('Incomplete translation batch')
  }
  const expected = new Map(units.map((u) => [u.id, u]))
  const result = new Map<string, readonly string[]>()
  for (const row of value.translations) {
    if (
      !exactKeys(row, ['id', 'segments']) ||
      typeof row.id !== 'string' ||
      !Array.isArray(row.segments)
    )
      throw new Error('Invalid translation row')
    const unit = expected.get(row.id)
    if (
      !unit ||
      result.has(row.id) ||
      row.segments.length !== unit.segments.length ||
      !row.segments.every((s) => typeof s === 'string')
    )
      throw new Error('Invalid translation identity or segments')
    result.set(row.id, [...row.segments])
  }
  return result
}

/** Editor-session scheduler. It owns no provider selection, editor state or disk storage. */
export class AiDocumentTranslator {
  private generation = 0
  private active?: AbortController
  private disposed = false
  private cache = new Map<string, Cached>()
  private cacheSize = 0
  private cacheContext?: string

  constructor(private readonly dependencies: DocumentTranslatorDependencies) {}

  stop(): void {
    this.generation++
    this.active?.abort()
    this.active = undefined
  }

  dispose(): void {
    this.stop()
    this.disposed = true
    this.cache.clear()
    this.cacheSize = 0
    this.cacheContext = undefined
  }

  private remember(key: string, unit: TranslationUnit, segments?: readonly string[]): void {
    const previous = this.cache.get(key)
    if (previous) this.cacheSize -= previous.size
    this.cache.delete(key)
    const entry = {
      unit: cloneUnit(unit),
      segments: segments && [...segments],
      size: key.length + JSON.stringify([unit, segments]).length,
    }
    this.cache.set(key, entry)
    this.cacheSize += entry.size
    const limit = Math.max(0, this.dependencies.cacheLimit ?? 512)
    while (this.cache.size > limit || this.cacheSize > 2_000_000) {
      const oldest = this.cache.keys().next().value as string
      this.cacheSize -= this.cache.get(oldest)!.size
      this.cache.delete(oldest)
    }
  }

  async run(
    input: DocumentTranslationSpec,
    signal?: AbortSignal,
  ): Promise<DocumentTranslationResult> {
    this.stop()
    if (this.disposed) throw new Error('Translation session disposed')
    if (!input.targetLanguage?.trim() || !input.provider?.trim() || typeof input.model !== 'string')
      throw new Error('Translation language, provider and model are required')
    if (
      input.range &&
      (!Number.isInteger(input.range.startBlockIndex) ||
        !Number.isInteger(input.range.endBlockIndex) ||
        input.range.startBlockIndex < 0 ||
        input.range.endBlockIndex < input.range.startBlockIndex ||
        input.includeNotes)
    )
      throw new Error('Invalid translation range or note scope')
    const spec = Object.freeze({
      ...input,
      range: input.range && Object.freeze({ ...input.range }),
    })
    const context = JSON.stringify([
      spec.provider,
      spec.model,
      spec.sourceLanguage ?? '',
      spec.targetLanguage,
      spec.context ?? '',
      spec.glossary ?? '',
      spec.style ?? '',
      spec.instructions ?? '',
    ])
    if (context !== this.cacheContext) {
      this.cache.clear()
      this.cacheSize = 0
      this.cacheContext = context
    }
    const generation = this.generation
    const controller = new AbortController()
    this.active = controller
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const alive = () => generation === this.generation && !controller.signal.aborted
    const result: DocumentTranslationResult = {
      completed: 0,
      reused: 0,
      failed: 0,
      stale: 0,
      skipped: 0,
      pending: 0,
      stopped: false,
      issues: [],
    }
    const report = () => {
      if (generation === this.generation)
        this.dependencies.onProgress?.({ ...result, issues: [...result.issues] })
    }
    const issue = (u: TranslationUnit, status: 'failed' | 'stale' | 'skipped', reason: string) => {
      result[status]++
      result.issues.push({ id: u.id, status, reason })
    }
    const units = this.dependencies.index.snapshot(spec.range, spec.includeNotes).map(cloneUnit)
    const work: Work[] = []
    for (const unit of units) {
      const receipt = this.cache.get(JSON.stringify(['receipt', unit.id]))
      const current = this.dependencies.index.current(unit.id)
      if (receipt && current && sameSource(receipt.unit, current) && sameSource(unit, current)) {
        result.reused++
        continue
      }
      if (JSON.stringify(unit.segments).length > 24_000) {
        issue(unit, 'skipped', 'Unit exceeds 24000 serialized source characters')
        continue
      }
      const key = JSON.stringify(['output', unit.id, unit.version, unit.shape, unit.segments])
      const cached = this.cache.get(key)
      work.push({
        unit,
        key,
        state: cached?.segments && sameSource(cached.unit, unit) ? 'ready' : 'waiting',
        segments: cached?.segments,
        reused: !!cached?.segments,
      })
    }
    result.pending = work.length
    const batches: Work[][] = []
    let batch: Work[] = []
    let length = 2
    for (const item of work.filter((item) => item.state === 'waiting')) {
      const size = JSON.stringify({ id: item.unit.id, segments: item.unit.segments }).length
      if (batch.length && (batch.length === 12 || length + size + 1 > 6000)) {
        batches.push(batch)
        batch = []
        length = 2
      }
      batch.push(item)
      length += size + (batch.length > 1 ? 1 : 0)
    }
    if (batch.length) batches.push(batch)
    let cursor = 0
    let snapshotted = false
    const flush = () => {
      while (alive() && cursor < work.length && work[cursor].state === 'ready') {
        const item = work[cursor++]
        item.state = 'done'
        if (item.error) issue(item.unit, 'failed', item.error)
        else if (!this.dependencies.index.resolve(item.unit))
          issue(item.unit, 'stale', 'Source changed before commit')
        else {
          if (!snapshotted) {
            this.dependencies.onBeforeCommit?.()
            snapshotted = true
          }
          if (!alive()) {
            cursor--
            item.state = 'ready'
            break
          }
          let commit: TranslationCommit
          try {
            commit = this.dependencies.commit(item.unit, item.segments!)
          } catch (error) {
            commit = {
              status: 'failed',
              reason: error instanceof Error ? error.message : String(error),
            }
          }
          if (commit.status === 'applied') {
            result.completed++
            if (item.reused) result.reused++
            this.remember(JSON.stringify(['receipt', item.unit.id]), commit.receipt)
          } else issue(item.unit, commit.status, commit.reason ?? 'Translation commit refused')
        }
        result.pending--
        report()
      }
    }
    let nextBatch = 0
    const cancelled = new Promise<undefined>((resolve) => {
      if (controller.signal.aborted) resolve(undefined)
      else controller.signal.addEventListener('abort', () => resolve(undefined), { once: true })
    })
    const worker = async () => {
      while (alive() && nextBatch < batches.length) {
        const items = batches[nextBatch++]
        try {
          const request = this.dependencies.request({
            spec,
            units: Object.freeze(
              items.map(({ unit }) =>
                Object.freeze({ id: unit.id, segments: Object.freeze([...unit.segments]) }),
              ),
            ),
            signal: controller.signal,
          })
          const reply = await Promise.race([request, cancelled])
          if (!alive() || reply === undefined) return
          const translations = validateReply(
            reply,
            items.map((item) => item.unit),
          )
          for (const item of items) {
            item.segments = translations.get(item.unit.id)!
            item.state = 'ready'
            this.remember(item.key, item.unit, item.segments)
          }
        } catch (error) {
          if (!alive()) return
          for (const item of items) {
            item.state = 'ready'
            item.error = error instanceof Error ? error.message : String(error)
          }
        }
        flush()
      }
    }
    try {
      flush()
      await Promise.all([worker(), worker()])
      flush()
      result.stopped = !alive()
      report()
      return result
    } finally {
      controller.abort()
      signal?.removeEventListener('abort', abort)
      if (this.active === controller) this.active = undefined
    }
  }
}

export function createAiDocumentTranslator(
  dependencies: DocumentTranslatorDependencies,
): AiDocumentTranslator {
  return new AiDocumentTranslator(dependencies)
}
