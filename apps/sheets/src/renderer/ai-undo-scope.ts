import { aiBulkUndoGate } from './univer-state'

/** Owns only synchronous facade calls, never the time spent awaiting file data. */
export function createAiUndoScope() {
  let active = true
  let dropped = false
  const facades = new WeakMap<object, object>()
  function run<T>(commit: () => T): T {
    if (!active) return commit()
    const previous = { ...aiBulkUndoGate }
    Object.assign(aiBulkUndoGate, { active: true, dropAll: true, dropped: false, pushed: 0 })
    try {
      return commit()
    } finally {
      dropped ||= aiBulkUndoGate.dropped
      Object.assign(aiBulkUndoGate, previous)
    }
  }
  function wrap<T>(value: T): T {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Promise) {
      return value
    }
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
    get dropped() {
      return dropped
    },
    settle() {
      active = false
    },
  }
}
