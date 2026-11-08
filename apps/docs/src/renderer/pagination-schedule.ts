/**
 * Scheduling decisions of the whole-document page pass (App.tsx pagination
 * effect), kept pure so they can be tested without a DOM.
 *
 * Control flow of one update, for reference:
 *  1. A transaction fires editor 'update'. `firstChangedTopLevelIndex` gives
 *     the first changed top-level block (also for a many-block change such as
 *     translate_blocks); `onUpdate` merges it into `dirtyFrom` (mergeDirty).
 *  2. The debounced `remeasure` hands `dirtyFrom` to `remeasurePass`, which
 *     lets `resumeFor` re-measure and re-slice only from the page before the
 *     first changed block. Only a null dirty index (fonts changed, a late
 *     width / suppression follow-up, a freshly started effect) is a full pass.
 *  3. The pagination effect closure holds all pass state (previous blocks and
 *     slices). Re-running the effect (a dependency changed identity) starts
 *     with no state and a synchronous full pass, so avoidable re-runs and
 *     redundant font-settled passes are what multiply passes after one update.
 */

/**
 * Merge a newly reported dirty index into the pending one. Infinity = nothing
 * pending, null = the whole document (absorbs everything until consumed).
 */
export function mergeDirty(pending: number | null, incoming: number | null): number | null {
  if (incoming === null || pending === null) return null
  return Math.min(pending, incoming)
}

/**
 * Cross-run loop guard for self-scheduled passes. The per-run follow-up
 * counter resets whenever the effect re-runs, so a cycle that includes an
 * effect re-run was never bounded; this window counter survives re-runs.
 */
export interface PassGovernor {
  /** register a follow-up about to be scheduled; false = refuse (loop) */
  allowFollowUp(now: number): boolean
  /** a user edit arrived: the budget starts over */
  reset(): void
}

export function createPassGovernor(maxInWindow = 12, windowMs = 5000): PassGovernor {
  let stamps: number[] = []
  return {
    allowFollowUp(now) {
      stamps = stamps.filter((t) => now - t < windowMs)
      if (stamps.length >= maxInWindow) return false
      stamps.push(now)
      return true
    },
    reset() {
      stamps = []
    },
  }
}

/**
 * The "fonts settled" notification an effect run registers when it starts.
 * When fonts were already loaded and this run's synchronous pass measured the
 * document, it was measured with those fonts: another whole-document pass
 * would reproduce it exactly.
 */
export function needsFontsReadyPass(o: {
  fontsLoading: boolean
  measuredBlocks: number
}): boolean {
  return o.fontsLoading || o.measuredBlocks === 0
}

/** shallow equality of two flat numeric records (header/footer reserved heights) */
export function sameNumbers(a: object, b: object): boolean {
  const x = a as Record<string, number | undefined>
  const y = b as Record<string, number | undefined>
  const keys = new Set([...Object.keys(x), ...Object.keys(y)])
  for (const k of keys) if (x[k] !== y[k]) return false
  return true
}
