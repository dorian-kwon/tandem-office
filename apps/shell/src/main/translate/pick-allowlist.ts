import { randomUUID } from 'node:crypto'

/**
 * Short-lived allowlist of paths the person picked in a native dialog.
 * The renderer only ever holds an opaque token, so it cannot make main copy
 * or create anything at a path the person did not pick. Entries expire and the
 * table is bounded so it cannot grow without limit.
 */
export interface PickEntry<M> {
  meta: M
  paths: (string | null)[]
  expiresAt: number
}

export const PICK_TTL_MS = 5 * 60 * 1000
export const PICK_MAX_ENTRIES = 32

export class PickAllowlist<M> {
  private readonly entries = new Map<string, PickEntry<M>>()

  constructor(
    private readonly now: () => number,
    private readonly newToken: () => string = randomUUID,
  ) {}

  add(meta: M, paths: string[]): string {
    this.sweep()
    while (this.entries.size >= PICK_MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    const token = this.newToken()
    this.entries.set(token, { meta, paths: [...paths], expiresAt: this.now() + PICK_TTL_MS })
    return token
  }

  /** The meta for a live token, or undefined. */
  meta(token: unknown): M | undefined {
    return typeof token === 'string' ? this.live(token)?.meta : undefined
  }

  /** The path at `index` of a live token, or undefined. */
  path(token: unknown, index: unknown): string | undefined {
    if (typeof token !== 'string' || typeof index !== 'number' || !Number.isInteger(index))
      return undefined
    return this.live(token)?.paths[index] ?? undefined
  }

  /** Use up one path (and the whole token once every path is used). */
  consume(token: string, index: number): void {
    const entry = this.live(token)
    if (!entry) return
    entry.paths[index] = null
    if (entry.paths.every((p) => p === null)) this.entries.delete(token)
  }

  private live(token: string): PickEntry<M> | undefined {
    const entry = this.entries.get(token)
    if (!entry) return undefined
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(token)
      return undefined
    }
    return entry
  }

  private sweep(): void {
    for (const token of [...this.entries.keys()]) this.live(token)
  }
}
