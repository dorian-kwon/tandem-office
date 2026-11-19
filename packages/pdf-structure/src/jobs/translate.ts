/**
 * The document translation job (spec §8) on the job engine. Blocks already
 * in the stored translation (translated or failed) are skipped; the rest are
 * cut into batches by the caller's `batch` (about 2,500 tokens each), one
 * call per batch. Each batch's blocks are stored together once it returns.
 * The translation's provider and model are recorded before its first block.
 *
 * Blocks a person edited are stored blocks too, so they count as done and
 * are never sent. A restart can keep them (`keepEdited`). A page translation
 * from the bilingual view (`kind: 'translate-page'`) runs on the same engine
 * but keeps its own job record, leaves an existing provider record alone and
 * never restarts.
 */
import {
  CONTEXT_PAIR_COUNT,
  CONTEXT_PAIR_LENGTH,
  OVERVIEW_TEXT_LIMIT,
  sourceExcerpt,
  type TranslationOverview,
  type TranslationBatchContext,
} from '../translate/context'
import type { TextUnit } from '../tree/derive'
import type { InlineRun } from '../tree/types'
import type { StoredTranslation, TranslationBlockInput } from '../store/store'
import { blockKeyString, translationBlockKeys, type TranslationBlockKey } from '../store/keys'
import type { DocumentJobStore } from './engine'
import { JobUnitFailure } from './errors'
import {
  startDocumentJob,
  type DocumentJobEstimate,
  type DocumentJobHandle,
  type JobModelChoice,
  type ProviderChange,
  type StartDocumentJobOptions,
} from './job'

/** a block to translate: a tree text unit or anything with its runs and page */
export type TranslationSourceBlock = Pick<TextUnit, 'runs' | 'pageFingerprint' | 'page'>

export interface TranslationJobItem<B> {
  block: B
  /** the block's key in the store */
  key: TranslationBlockKey
}

/** the result for one block of a batch, in the batch's order */
export type TranslationBlockResult =
  | { status: 'translated'; text: string; runs?: InlineRun[] }
  /** the block stays in the source language (spec §8: placeholders kept failing) */
  | { status: 'failed'; reason: string }

export interface TranslationJobInput<B extends TranslationSourceBlock> {
  docHash: string
  /** target language code */
  lang: string
  /** every block of the confirmed page range, in reading order */
  blocks: readonly B[]
  /** cut the pending blocks into batches (each non-empty, all blocks once, in order) */
  batch: (items: readonly TranslationJobItem<B>[]) => TranslationJobItem<B>[][]
  model: JobModelChoice
  store: Pick<
    DocumentJobStore,
    | 'readTranslation'
    | 'writeTranslationMeta'
    | 'writeTranslationBlocks'
    | 'deleteTranslation'
    | 'deleteTranslationExceptEdited'
    | 'writeJob'
  >
  /**
   * 'translate' (default): the document translation, record
   * `translate.<lang>`. 'translate-page': a page translation, record
   * `translate-page.<lang>`; the provider record is written only when there
   * is none; it cannot restart.
   */
  kind?: 'translate' | 'translate-page'
  /** start over: the stored translation is replaced (the user confirmed it) */
  restart?: boolean
  /**
   * with `restart`: blocks a person edited stay (and count as done); only the
   * others are removed and sent again. Needs a store with
   * `deleteTranslationExceptEdited`.
   */
  keepEdited?: boolean
}

export interface TranslationJobPlan<B> {
  estimate: DocumentJobEstimate
  batches: TranslationJobItem<B>[][]
}

type PlanInput<B extends TranslationSourceBlock> = Omit<TranslationJobInput<B>, 'store'> & {
  store: Pick<DocumentJobStore, 'readTranslation'>
}

export async function planTranslationJob<B extends TranslationSourceBlock>(
  input: PlanInput<B>,
): Promise<TranslationJobPlan<B>> {
  return (await planWithStored(input)).plan
}

/** the plan, and the stored translation it was made against (edited blocks only on a restart) */
async function planWithStored<B extends TranslationSourceBlock>(
  input: PlanInput<B>,
): Promise<{
  plan: TranslationJobPlan<B>
  stored: StoredTranslation | null
  keys: TranslationBlockKey[]
}> {
  const keys = translationBlockKeys(input.blocks)
  const read =
    input.restart && !input.keepEdited
      ? null
      : await input.store.readTranslation(input.docHash, input.lang)
  // a restart that keeps the edits starts from them alone
  const stored =
    read && input.restart
      ? { ...read, blocks: new Map([...read.blocks].filter(([, b]) => b.edited === true)) }
      : read
  const pending: TranslationJobItem<B>[] = []
  input.blocks.forEach((block, i) => {
    const key = keys[i]!
    if (!stored?.blocks.has(blockKeyString(key))) pending.push({ block, key })
  })
  const batches = pending.length > 0 ? input.batch(pending) : []
  const batched = batches.reduce((n, b) => n + b.length, 0)
  if (batches.some((b) => b.length === 0) || batched !== pending.length) {
    throw new TypeError('translation job: the batches must hold every pending block once')
  }

  let providerChange: ProviderChange | null = null
  if (
    !input.restart &&
    stored &&
    stored.blocks.size > 0 &&
    (stored.provider !== input.model.provider || stored.model !== input.model.model)
  ) {
    providerChange = {
      stored: { provider: stored.provider, model: stored.model },
      next: { ...input.model },
    }
  }

  const done = input.blocks.length - pending.length
  return {
    stored,
    keys,
    plan: {
      batches,
      estimate: {
        kind: input.kind ?? 'translate',
        lang: input.lang,
        calls: batches.length,
        pending: pending.length,
        done,
        total: input.blocks.length,
        model: { ...input.model },
        providerChange,
      },
    },
  }
}

/** the pre-start confirmation data: calls, blocks already translated, provider change */
export async function estimateTranslationJob<B extends TranslationSourceBlock>(
  input: PlanInput<B>,
): Promise<DocumentJobEstimate> {
  return (await planTranslationJob(input)).estimate
}

export interface StartTranslationJobOptions<B extends TranslationSourceBlock>
  extends TranslationJobInput<B>, StartDocumentJobOptions<TranslationJobItem<B>[]> {
  /** Optional source-only evidence, scoped to the pages/chapters the person selected. */
  overview?: {
    scope: string | ((keys: readonly TranslationBlockKey[]) => string)
    build: () => string
  }
  onAnalyzing?: () => void | Promise<void>
  /** translate one batch; one result per block, in order */
  callModel: (
    batch: TranslationJobItem<B>[],
    signal: AbortSignal,
    context?: TranslationBatchContext,
  ) => Promise<TranslationBlockResult[]>
}

const isResult = (r: unknown): r is TranslationBlockResult => {
  if (typeof r !== 'object' || r === null) return false
  const v = r as Record<string, unknown>
  if (v.status === 'translated') return typeof v.text === 'string'
  return v.status === 'failed' && typeof v.reason === 'string'
}

function toInput(key: TranslationBlockKey, r: TranslationBlockResult): TranslationBlockInput {
  if (r.status === 'failed') return { key, status: 'failed', reason: r.reason }
  const input: TranslationBlockInput = { key, status: 'translated', text: r.text }
  if (r.runs !== undefined) input.runs = r.runs
  return input
}

/** start translating; throws DocumentJobBusyError when the document has a job */
export function startTranslationJob<B extends TranslationSourceBlock>(
  o: StartTranslationJobOptions<B>,
): DocumentJobHandle<TranslationJobItem<B>[]> {
  type Batch = TranslationJobItem<B>[]
  const jobKind = o.kind ?? 'translate'
  if (jobKind === 'translate-page' && o.restart) {
    throw new TypeError('translation job: a page translation does not restart')
  }
  const source = jobKind === 'translate' ? o.overview : undefined
  return startDocumentJob<Batch, TranslationBlockResult[]>(
    // Each contextual batch uses only translations committed before it in document order.
    { ...o, kind: jobKind, ...(source ? { concurrency: 1 } : {}) },
    async (signal) => {
      if (o.restart && !signal.aborted) {
        if (!o.keepEdited) await o.store.deleteTranslation(o.docHash, o.lang)
        else if (o.store.deleteTranslationExceptEdited) {
          await o.store.deleteTranslationExceptEdited(o.docHash, o.lang)
        } else {
          // deleting everything instead would lose the person's edits
          throw new TypeError('translation job: this store cannot keep edited blocks on a restart')
        }
      }
      const {
        plan: { batches, estimate },
        stored,
        keys,
      } = await planWithStored({ ...o, restart: false })
      // a page translation leaves the provider record of the document translation alone
      const writeMeta = jobKind === 'translate' || !stored || stored.provider === null
      let meta: Promise<void> | null = null
      let overview: TranslationOverview | undefined
      if (source && batches.length && !signal.aborted) {
        const scope = typeof source.scope === 'string' ? source.scope : source.scope(keys)
        if (stored?.overview?.scope === scope) {
          overview = stored.overview
        } else {
          await o.onAnalyzing?.()
          if (!signal.aborted) {
            overview = { scope, text: source.build().slice(0, OVERVIEW_TEXT_LIMIT) }
            await o.store.writeTranslationMeta(o.docHash, o.lang, {
              provider: stored?.provider ?? o.model.provider,
              model: stored?.model ?? o.model.model,
              overview,
            })
            if (
              !stored?.provider ||
              (stored.provider === o.model.provider && stored.model === o.model.model)
            )
              meta = Promise.resolve()
          }
        }
      }
      // Scan selected source blocks once. Resume can have holes; load an edited or
      // previously completed block only when it precedes this batch, never from a later page.
      const previous: TranslationBatchContext['previous'] = []
      const repeated = new Set<string>()
      if (overview) {
        const seen = new Set<string>()
        for (const { textHash } of keys) {
          if (seen.has(textHash)) repeated.add(textHash)
          else seen.add(textHash)
        }
      }
      const accepted = new Map<string, NonNullable<TranslationBatchContext['matches']>[number]>()
      // A resumed batch can span saved blocks between two pending items. Keep their locations
      // so a later item sees the accepted example, while an earlier one cannot see a future edit.
      const savedMatches = new Map<
        string,
        NonNullable<TranslationBatchContext['matches']>[number]
      >()
      if (repeated.size && stored?.blocks.size) {
        const last = new Map<string, NonNullable<TranslationBatchContext['matches']>[number]>()
        keys.forEach((key, index) => {
          if (!repeated.has(key.textHash)) return
          const id = blockKeyString(key)
          const saved = stored.blocks.get(id)
          if (saved?.status === 'translated' && saved.text) {
            const target = saved.text.slice(0, CONTEXT_PAIR_LENGTH)
            if (target.trim())
              last.set(key.textHash, {
                source: sourceExcerpt(o.blocks[index]!.runs, CONTEXT_PAIR_LENGTH),
                target,
                page: o.blocks[index]!.page,
                unit: index + 1,
              })
          } else if (!saved) {
            const match = last.get(key.textHash)
            if (match) savedMatches.set(id, match)
          }
        })
      }
      let cursor = 0
      function remember(block: B, key: TranslationBlockKey, text: string) {
        const target = text.slice(0, CONTEXT_PAIR_LENGTH)
        if (!target.trim()) return
        const pair = { source: sourceExcerpt(block.runs, CONTEXT_PAIR_LENGTH), target }
        previous.push(pair)
        if (repeated.has(key.textHash)) {
          accepted.set(key.textHash, { ...pair, page: block.page, unit: cursor + 1 })
        }
        if (previous.length > CONTEXT_PAIR_COUNT) previous.shift()
      }
      function advanceTo(key: TranslationBlockKey) {
        while (cursor < keys.length) {
          const at = keys[cursor]!
          if (
            at === key ||
            (at.textHash === key.textHash &&
              at.pageFingerprint === key.pageFingerprint &&
              at.occurrence === key.occurrence)
          )
            break
          const saved = stored?.blocks.get(blockKeyString(keys[cursor]!))
          if (saved?.status === 'translated' && saved.text)
            remember(o.blocks[cursor]!, keys[cursor]!, saved.text)
          cursor++
        }
      }
      return {
        store: o.store,
        units: batches,
        unitSize: (batch) => batch.length,
        doneBefore: estimate.done,
        total: estimate.total,
        callModel: async (batch, callSignal) => {
          let context: TranslationBatchContext | undefined
          if (overview) {
            advanceTo(batch[0]!.key)
            const matches: NonNullable<TranslationBatchContext['matches']> = []
            for (const { key } of batch) {
              const prior = accepted.get(key.textHash)
              const saved = savedMatches.size ? savedMatches.get(blockKeyString(key)) : undefined
              const match = saved && (!prior || saved.unit > prior.unit) ? saved : prior
              if (match && !matches.some((p) => p.unit === match.unit)) matches.push(match)
              if (matches.length === CONTEXT_PAIR_COUNT) break
            }
            context = {
              overview: overview.text,
              previous: [...previous],
              ...(matches.length ? { matches } : {}),
            }
          }
          const results = await o.callModel(batch, callSignal, context)
          if (!Array.isArray(results) || results.length !== batch.length) {
            throw new JobUnitFailure('result-mismatch')
          }
          if (!results.every(isResult)) throw new JobUnitFailure('result-mismatch')
          return results
        },
        persist: async (batch, results) => {
          meta ??= writeMeta
            ? o.store.writeTranslationMeta(o.docHash, o.lang, {
                provider: o.model.provider,
                model: o.model.model,
                ...(overview ? { overview } : {}),
              })
            : Promise.resolve()
          await meta
          await o.store.writeTranslationBlocks(
            o.docHash,
            o.lang,
            batch.map((item, i) => toInput(item.key, results[i]!)),
          )
          if (overview) {
            batch.forEach((item, i) => {
              advanceTo(item.key)
              const result = results[i]!
              if (result.status === 'translated') remember(item.block, item.key, result.text)
              cursor++
            })
          }
        },
      }
    },
  )
}
