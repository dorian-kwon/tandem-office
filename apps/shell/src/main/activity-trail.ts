import { isActionWord } from './crash-log'
import type { TrailItem } from './crash-log'

/**
 * A short, in-memory trail of what the person and the app were doing, kept so a
 * crash line can say what led up to it. Only fixed action words are kept
 * (`tab-open:docs`, `ai-start`, `update-check`) with the seconds since the app
 * started: never a title, a path, a file name or any text typed or opened.
 * Nothing here is written to disk by itself; a crash line copies the newest
 * entries when it is recorded, and the problem report lists the current ones.
 */

const DEFAULT_MAX = 60

export interface ActivityTrail {
  /** add an action; a word that is not a plain action word is ignored */
  note(action: string): void
  /** the newest `count` entries (all of them by default), oldest first, as copies */
  recent(count?: number): TrailItem[]
  /** whole seconds since the trail began */
  uptimeS(): number
}

export function createActivityTrail(
  options: { max?: number; now?: () => number } = {},
): ActivityTrail {
  const max = options.max ?? DEFAULT_MAX
  const now = options.now ?? Date.now
  const startedAt = now()
  const items: TrailItem[] = []
  const seconds = (): number => Math.max(0, Math.floor((now() - startedAt) / 1000))
  return {
    note(action) {
      if (!isActionWord(action)) return
      items.push({ t: seconds(), a: action })
      if (items.length > max) items.splice(0, items.length - max)
    },
    recent(count) {
      const slice = count === undefined ? items : items.slice(-count)
      return slice.map((item) => ({ ...item }))
    },
    uptimeS: seconds,
  }
}

/** the trail of this run of the app */
export const activityTrail: ActivityTrail = createActivityTrail()

/** record an action in this run's trail */
export function noteActivity(action: string): void {
  activityTrail.note(action)
}

/** the minimum of a tab the trail needs: which tab, and which editor it is */
export interface TrailTab {
  id: string
  kind: string
}

/**
 * The actions a change of the tab list stands for (`tab-open:docs`, `tab-close:sheets`) and the
 * tab map to remember for the next change. Only the editor kind is named, never a title or path.
 */
export function tabChangeActions(
  previous: ReadonlyMap<string, string>,
  tabs: readonly TrailTab[],
): { actions: string[]; next: Map<string, string> } {
  const next = new Map(tabs.map((tab) => [tab.id, tab.kind]))
  const actions: string[] = []
  for (const [id, kind] of next) {
    if (!previous.has(id) && isActionWord(`tab-open:${kind}`)) actions.push(`tab-open:${kind}`)
  }
  for (const [id, kind] of previous) {
    if (!next.has(id) && isActionWord(`tab-close:${kind}`)) actions.push(`tab-close:${kind}`)
  }
  return { actions, next }
}

/** open tabs per editor kind; Home is always there and is left out */
export function tabCounts(tabs: readonly TrailTab[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const tab of tabs) {
    if (tab.kind === 'home') continue
    counts[tab.kind] = (counts[tab.kind] ?? 0) + 1
  }
  return counts
}
