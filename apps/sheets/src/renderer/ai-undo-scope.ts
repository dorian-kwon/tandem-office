import type { IUndoRedoItem } from '@univerjs/core'
import {
  AI_UNDO_CELL_BUDGET,
  aiUndoSource,
  undoPayloadCells,
  type AiUndoStacks,
} from './univer-state'

const ids = new WeakMap<object, string>()
function markAiUndoEntry(entry: object): string {
  const id = crypto.randomUUID()
  ids.set(entry, id)
  return id
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
  return (
    expected.length > 0 &&
    stack.length >= expected.length &&
    expected.every((id, i) => ids.get(stack[stack.length - expected.length + i]!) === id)
  )
}

/** Owns only synchronous facade calls, never the time spent awaiting file data. */
export function createAiUndoScope(record = false, verifySession?: () => void) {
  let active = true
  let dropped = false
  const facades = new WeakMap<object, object>()
  const entries = new Map<IUndoRedoItem, string>()
  let settledIds: string[] | undefined
  let cells = 0
  function pushItem(service: AiUndoStacks, item: IUndoRedoItem, push: () => void): void {
    const stack = service._getUndoStack(item.unitID)
    const redo = service._getRedoStack(item.unitID)
    if (record && !dropped) cells += undoPayloadCells(item, AI_UNDO_CELL_BUDGET)
    if (!record || cells > AI_UNDO_CELL_BUDGET) {
      // A partially recorded batch must not leave any of its segments behind.
      if (!dropped && stack) {
        for (let i = stack.length - 1; i >= 0; i--) {
          if (entries.has(stack[i]!)) stack.splice(i, 1)
        }
      }
      const previousTop = stack?.at(-1)
      if (previousTop) ids.delete(previousTop)
      entries.clear()
      dropped = true
      if (redo) redo.length = 0
      service._updateStatus()
      return
    }
    const top = stack?.at(-1)
    if (top && entries.has(top) && !redo?.length) {
      // Undo commands in reverse order; each command's mutations retain their
      // internal order. Redo applies the original commands in forward order.
      top.undoMutations.unshift(...item.undoMutations)
      top.redoMutations.push(...item.redoMutations)
    } else {
      entries.set(item, markAiUndoEntry(item))
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
