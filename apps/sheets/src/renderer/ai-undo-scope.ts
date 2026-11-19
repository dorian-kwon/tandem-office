import type { ChangePlan } from '@genoffice/xlsx-gateway/domain/workbook.types'
import { newTranslationItem, translationHistory } from './translation-history'
import type { IUndoRedoItem } from '@univerjs/core'
import {
  AI_UNDO_CELL_BUDGET,
  aiUndoSource,
  undoPayloadCells,
  type AiUndoStacks,
} from './univer-state'

interface AiEntry {
  id: string | undefined
  cells: number
  cellOnly: boolean
}
const aiEntries = new WeakMap<object, AiEntry>()

/** Save/reopen rewrites Univer's items. Keep the cost on the replacement so
 * repeated autosaves cannot reset the workbook's retained AI cell budget. */
export function carryAiEntryCost(original: object, replacement: unknown): void {
  const meta = aiEntries.get(original)
  if (meta && replacement && typeof replacement === 'object')
    aiEntries.set(replacement, { ...meta, id: undefined })
}

/** A removed structural edit can shift the coordinates of an older manual
 * inverse. Only a prefix or ordinary cell writes can expire safely. */
function makeRoom(
  stack: IUndoRedoItem[],
  own: ReadonlyMap<IUndoRedoItem, string>,
  cells: number,
): boolean {
  let retained = cells
  for (const item of stack)
    retained += translationHistory(item)?.cells ?? aiEntries.get(item)?.cells ?? 0
  if (retained <= AI_UNDO_CELL_BUDGET) return true

  const evict: number[] = []
  const shrink: (() => void)[] = []
  for (let i = 0; i < stack.length; i++) {
    const item = stack[i]!
    const meta = aiEntries.get(item)
    const pack = translationHistory(item)
    if (pack) {
      let count = 0
      let freed = 0
      while (count < pack.steps.length && retained > AI_UNDO_CELL_BUDGET) {
        const step = pack.steps[count]!
        if (own.has(step.item)) break
        retained -= step.cells
        freed += step.cells
        count++
      }
      if (count === pack.steps.length) evict.push(i)
      else if (count)
        shrink.push(() => {
          pack.steps.splice(0, count)
          pack.cells -= freed
        })
    } else {
      if (!meta?.cells || own.has(item) || (i !== evict.length && !meta.cellOnly)) continue
      evict.push(i)
      retained -= meta.cells
    }
    if (retained <= AI_UNDO_CELL_BUDGET) {
      for (const trim of shrink) trim()
      for (let j = evict.length - 1; j >= 0; j--) stack.splice(evict[j]!, 1)
      return true
    }
  }
  return false
}

function isCellHistory(item: IUndoRedoItem): boolean {
  const cellMutation = (mutation: IUndoRedoItem['undoMutations'][number]) =>
    mutation.id === 'sheet.mutation.set-range-values' ||
    mutation.id === 'sheet.operation.set-selections' ||
    (mutation.params as { adapterSnapshot?: boolean } | undefined)?.adapterSnapshot === true
  return item.undoMutations.every(cellMutation) && item.redoMutations.every(cellMutation)
}

export const MIXED_TRANSLATION_PLAN =
  'Translation batches accept only cell text. Send translated values with translation:true. Apply requested formatting, formulas, or sheet layout in a separate ordinary batch.'

/** Check the planned changes so range writes and other DSL expansions follow the same rule. */
export function translationCellPlan(plan: ChangePlan): boolean {
  return (
    plan.structuralChanges.length === 0 &&
    plan.formatChanges.length === 0 &&
    plan.sheetRenames.length === 0 &&
    plan.cellChanges.every((c) => typeof c.after.value === 'string' && !c.after.formula)
  )
}

export function undoCapacityNotice(record: boolean): string {
  return record
    ? 'the workbook has insufficient undo history capacity for this change — the [Undo] button and ⌘Z will not revert it'
    : 'undo history for AI edits is turned off in the settings — the [Undo] button and ⌘Z will not revert this change'
}

/** Once part of an answer has no undo entry, its button cannot revert the
 * entire answer, even if a later proposal can be recorded. */
export function appendAiUndoEntries(
  previous: readonly string[] | undefined,
  next: readonly string[],
): readonly string[] {
  return previous?.length === 0 || next.length === 0 ? [] : [...(previous ?? []), ...next]
}

export function matchesAiUndoEntries(
  stack: readonly object[],
  expected: readonly string[],
): boolean {
  let i = expected.length
  if (!i) return false
  for (let k = stack.length - 1; k >= 0; k--) {
    const item = stack[k]!
    const pack = translationHistory(item)
    if (pack) {
      for (let j = pack.steps.length - 1; j >= 0; j--) {
        if (aiEntries.get(pack.steps[j]!.item)?.id !== expected[--i]) return false
        if (!i) return true
      }
    } else {
      if (aiEntries.get(item)?.id !== expected[--i]) return false
      if (!i) return true
    }
  }
  return false
}

/** Owns only synchronous facade calls, never the time spent awaiting file data. */
export function createAiUndoScope(
  record = false,
  verifySession?: () => void,
  unitId?: string,
  translation = false,
) {
  let active = true
  let dropped = false
  const facades = new WeakMap<object, object>()
  const entries = new Map<IUndoRedoItem, string>()
  let settledIds: string[] | undefined
  let cells = 0
  let cellGroup: { first?: IUndoRedoItem } | undefined
  function pushItem(
    service: AiUndoStacks,
    item: IUndoRedoItem,
    push: (replacement?: IUndoRedoItem) => void,
  ): void {
    // Synchronous grid writes can also refresh Univer's internal text editor.
    // That document owns its own history, and cannot appear in a workbook receipt.
    if (unitId && item.unitID !== unitId) {
      if (record) push()
      return
    }
    const stack = service._getUndoStack(item.unitID)
    const redo = service._getRedoStack(item.unitID)
    const depth = stack?.length
    const top = stack?.at(-1)
    const merge = top !== undefined && entries.has(top) && !redo?.length
    const added = record && !dropped ? undoPayloadCells(item, AI_UNDO_CELL_BUDGET) : 0
    cells += added
    if (
      !record ||
      dropped ||
      cells > AI_UNDO_CELL_BUDGET ||
      !makeRoom(stack ?? [], entries, added)
    ) {
      // A partially recorded batch must not leave any of its segments behind.
      if (!dropped && stack) {
        for (let i = stack.length - 1; i >= 0; i--) {
          const pack = translationHistory(stack[i])
          if (pack) {
            while (pack.steps.length && entries.has(pack.steps.at(-1)!.item))
              pack.cells -= pack.steps.pop()!.cells
            if (!pack.steps.length) stack.splice(i, 1)
          } else if (entries.has(stack[i]!)) stack.splice(i, 1)
        }
      }
      const candidate = stack?.at(-1)
      const previousTop = translationHistory(candidate)?.steps.at(-1)?.item ?? candidate
      const previousMeta = previousTop && aiEntries.get(previousTop)
      if (previousMeta) previousMeta.id = undefined
      entries.clear()
      dropped = true
      if (redo) redo.length = 0
      service._updateStatus()
      return
    }
    if (translation) {
      const pack = translationHistory(stack?.at(-1))
      const last = pack?.steps.at(-1)
      if (pack && last && cellGroup?.first === last.item) {
        last.item.undoMutations.unshift(...item.undoMutations)
        last.item.redoMutations.push(...item.redoMutations)
        last.cells += added
        pack.cells += added
        return
      }
      if (cellGroup) cellGroup.first = item
      const id = crypto.randomUUID()
      aiEntries.set(item, { id, cells: added, cellOnly: true })
      entries.set(item, id)
      if (pack && !redo?.length) {
        pack.steps.push({ item, cells: added })
        pack.cells += added
      } else push(newTranslationItem(item, added))
      return
    }
    if (merge) {
      const meta = aiEntries.get(top)!
      meta.cells += added
      meta.cellOnly &&= isCellHistory(item)
      // Undo commands in reverse order; each command's mutations retain their
      // internal order. Redo applies the original commands in forward order.
      top.undoMutations.unshift(...item.undoMutations)
      top.redoMutations.push(...item.redoMutations)
      if (stack?.length !== depth) service._updateStatus()
    } else {
      const id = crypto.randomUUID()
      aiEntries.set(item, { id, cells: added, cellOnly: isCellHistory(item) })
      entries.set(item, id)
      push()
    }
  }
  const source = { push: pushItem, discarding: () => !record || dropped }
  function run<T>(commit: () => T): T {
    if (!active) return commit()
    verifySession?.()
    const previous = aiUndoSource.current
    aiUndoSource.current = source
    try {
      return commit()
    } finally {
      if (previous) aiUndoSource.current = previous
      else delete aiUndoSource.current
    }
  }
  function wrap<T>(value: T): T {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Promise) {
      return value
    }
    // Plain result objects (cell data, styles, and snapshots) must remain
    // cloneable when handed to Univer; only callable facades own commands.
    if (
      Object.getPrototypeOf(value) === Object.prototype &&
      !Object.values(value).some((member) => typeof member === 'function')
    )
      return value
    const cached = facades.get(value)
    if (cached) return cached as T
    const facade = new Proxy(value, {
      get(target, key) {
        const member = Reflect.get(target, key, target)
        if (typeof member === 'function') {
          return (...args: unknown[]) => run(() => wrap(member.apply(target, args)))
        }
        return member
      },
    })
    facades.set(value, facade)
    return facade
  }
  return {
    run,
    wrap,
    cell<T>(commit: () => T): T {
      cellGroup = {}
      try {
        return run(commit)
      } finally {
        cellGroup = undefined
      }
    },
    get entryIds() {
      return settledIds ?? [...entries.values()]
    },
    get dropped() {
      return dropped
    },
    settle() {
      if (!active) return
      active = false
      settledIds = [...entries.values()]
      entries.clear()
    },
  }
}
