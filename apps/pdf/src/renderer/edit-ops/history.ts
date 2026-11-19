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
  return rebaseFrames(stack, before, after, plan, context) as EditSnapshot[]
}

export function rebaseFrames(
  stack: PdfHistoryFrame[],
  before: EditSnapshot,
  after: EditSnapshot,
  plan: PlanResult,
  context: (state: EditSnapshot) => OpContext,
): PdfHistoryFrame[] {
  if (!stack.length) return stack
  const rebased: PdfHistoryFrame[] = []
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
  let previous = before
  let newer = after
  for (let index = stack.length - 1; index >= 0; index--) {
    const stored = stack[index]!
    const frame = restoreFrame(stored, previous)
    previous = frame
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
    if (BUCKETS.some((key) => next[key] !== newer[key])) rebased.push(inverseFrame(stored, next))
    if ('kind' in stored) cache.get('textEdits')?.delete(frame.textEdits)
    newer = next
  }
  return rebased.reverse()
}

// A text undo entry owns only the spans this edit touched. Saving a full
// textEdits array at every heading would retain a triangular number of slots.
type TextFrame = {
  kind: 'text'
  records: Array<{ id: string; index: number; value?: EditSnapshot['textEdits'][number] }>
}
export type PdfHistoryFrame = EditSnapshot | TextFrame

export function textFrame(edits: EditSnapshot['textEdits'], ids: readonly string[]): TextFrame {
  const wanted = new Set(ids)
  const records: TextFrame['records'] = []
  edits.forEach((value, index) => {
    if (wanted.delete(value.id)) records.push({ id: value.id, index, value })
  })
  for (const id of wanted) records.push({ id, index: -1 })
  return { kind: 'text', records }
}

export function restoreFrame(frame: PdfHistoryFrame, current: EditSnapshot): EditSnapshot {
  if (!('kind' in frame)) return frame
  const ids = new Set(frame.records.map((r) => r.id))
  const textEdits = current.textEdits.filter((r) => !ids.has(r.id))
  for (const r of frame.records) if (r.value) textEdits.splice(r.index, 0, r.value)
  return { ...current, textEdits }
}

export function inverseFrame(frame: PdfHistoryFrame, current: EditSnapshot): PdfHistoryFrame {
  return 'kind' in frame
    ? textFrame(
        current.textEdits,
        frame.records.map((r) => r.id),
      )
    : current
}

export function appendFrame(stack: PdfHistoryFrame[], frame: PdfHistoryFrame): PdfHistoryFrame[] {
  // Independent text edits use small deltas. Keep the pre-existing budget
  // for full-document frames, including interleaved manual operations.
  let start = Math.max(0, stack.length - 1999)
  if (!('kind' in frame)) {
    let full = 1
    for (let i = stack.length - 1; i >= start; i--) {
      if (!('kind' in stack[i]!) && ++full > 50) {
        start = i + 1
        break
      }
    }
  }
  return [...stack.slice(start), frame]
}
