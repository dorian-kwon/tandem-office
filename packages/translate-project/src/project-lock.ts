import { resolve } from 'node:path'

const tails = new Map<string, Promise<unknown>>()

/**
 * Run `fn` after every earlier task for the same project directory has settled.
 * A failed task does not block the ones queued behind it.
 */
export function withProjectLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(dir)
  const prev = tails.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  tails.set(key, tail)
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key)
  })
  return run
}
