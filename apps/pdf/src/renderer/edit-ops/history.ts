import { aiEditUndoHistoryEnabled } from '@genoffice/ui'
import type { EditSnapshot } from '../edit-state'
import {
  BUCKETS,
  lookup,
  planEditOps,
  reduceBucket,
  type Bucket,
  type OpContext,
  type PlanResult,
} from './registry'

/** Record at the commit, after validation; never keep a scope open during async work. */
export function recordEditHistory(aiEdit: boolean, record: () => void, skip: () => void): void {
  if (aiEdit && !aiEditUndoHistoryEnabled()) skip()
  else record()
}

/** Carry a successful, unrecorded batch into earlier undo states. Share each
 * affected bucket wherever the snapshots shared it. If the edit depends on
 * a page, image or field that did not exist yet, stop at that undo boundary. */
export function rebaseEditHistory(
  stack: EditSnapshot[],
  before: EditSnapshot,
  after: EditSnapshot,
  plan: PlanResult,
  context: (state: EditSnapshot) => OpContext,
): EditSnapshot[] {
  if (!stack.length) return stack
  const rebased: EditSnapshot[] = []
  const cache = new Map<Bucket, Map<unknown, unknown>>()
  for (const key of plan.touched) cache.set(key, new Map([[before[key], after[key]]]))
  // AI commonly appends many annotations in one batch. Reuse the actual
  // inserted records in all frames instead of recreating the batch per frame.
  const appendOps: Partial<Record<Bucket, string>> = {
    markups: 'addMarkup',
    drawings: 'addDrawing',
    textInserts: 'addTextInsert',
    imageEdits: 'addImageEdit',
    formFields: 'addFormField',
  }
  const additions = new Map<Bucket, readonly unknown[]>()
  for (const key of plan.touched) {
    const from = before[key]
    const to = after[key]
    if (
      appendOps[key] &&
      Array.isArray(from) &&
      Array.isArray(to) &&
      plan.ops.every((op) => op.op === appendOps[key] || !lookup(op.op).touches.includes(key))
    ) {
      additions.set(key, to.slice(from.length))
    }
  }
  const fieldValues = plan.ops.filter((op) => op.op === 'setFormValue')
  function update<K extends Bucket>(frame: EditSnapshot, next: EditSnapshot, key: K) {
    const cacheForKey = cache.get(key)!
    if (!cacheForKey.has(frame[key])) {
      const added = additions.get(key)
      const previous = frame[key]
      cacheForKey.set(
        previous,
        added && Array.isArray(previous)
          ? [...previous, ...added]
          : reduceBucket(key, previous, plan.ops, frame),
      )
    }
    next[key] = cacheForKey.get(frame[key]) as EditSnapshot[K]
  }
  let newer = after
  for (let index = stack.length - 1; index >= 0; index--) {
    const frame = stack[index]!
    if (
      frame.blankPages !== before.blankPages ||
      frame.deleted !== before.deleted ||
      frame.imageEdits !== before.imageEdits ||
      frame.formFields !== before.formFields ||
      frame.formWidgetEdits !== before.formWidgetEdits
    ) {
      const ctx = context(frame)
      // The operations are already stamped with their ids.
      if (
        planEditOps(plan.ops, ctx, () => {
          throw new Error('Missing planned id')
        }).failures.length
      )
        break
      if (
        fieldValues.some((op) => {
          const { name } = op.value as { name: string }
          return (
            before.formFields.some((field) => field.input.name === name) &&
            !ctx.fieldNames?.has(name)
          )
        })
      )
        break
    }
    const next = { ...frame }
    for (const key of plan.touched) update(frame, next, key)
    if (BUCKETS.some((key) => next[key] !== newer[key])) rebased.push(next)
    newer = next
  }
  return rebased.reverse()
}
