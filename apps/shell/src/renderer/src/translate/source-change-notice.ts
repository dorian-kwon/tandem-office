import { useSyncExternalStore } from 'react'

/**
 * Source tabs whose copy in `source/` no longer matched its recorded hash when
 * the translation view opened them. The detail screen (Home) records them and
 * the tab strip's notice (TranslationPaneToggle) shows them, because the split
 * covers Home once it opens. Both live in the shell window's one renderer.
 */
let changed: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()

function publish(next: ReadonlySet<string>): void {
  changed = next
  for (const listener of listeners) listener()
}

export function markSourceChanged(tabId: string): void {
  if (changed.has(tabId)) return
  publish(new Set([...changed, tabId]))
}

export function dismissSourceChanged(tabId: string): void {
  if (!changed.has(tabId)) return
  const next = new Set(changed)
  next.delete(tabId)
  publish(next)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useChangedSources(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => changed)
}
