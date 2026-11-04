import type { TranslateProjectListEntry } from '../../../shared/translate-api'

export type SortKey = 'name' | 'lastOpened'
export type SortState = { key: SortKey; dir: 'asc' | 'desc' }

/** Newest first, the order the list opens in. */
export const DEFAULT_SORT: SortState = { key: 'lastOpened', dir: 'desc' }

/** A sorted copy; names compare case-insensitively in the screen language, ties keep order. */
export function sortProjects(
  list: readonly TranslateProjectListEntry[],
  sort: SortState,
  lang: string,
): TranslateProjectListEntry[] {
  const sign = sort.dir === 'asc' ? 1 : -1
  const collator = new Intl.Collator(lang, { sensitivity: 'base', numeric: true })
  return list
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const diff =
        sort.key === 'name'
          ? collator.compare(a.entry.name, b.entry.name)
          : a.entry.lastOpened - b.entry.lastOpened
      return diff !== 0 ? sign * diff : a.index - b.index
    })
    .map((x) => x.entry)
}

/** `text` cut to `max` characters with an ellipsis in the middle (both ends stay readable). */
export function middleEllipsis(text: string, max: number): string {
  if (text.length <= max || max < 5) return text
  const keep = max - 1
  const tail = Math.ceil(keep / 2)
  const head = keep - tail
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

/**
 * Up/Down/Home/End on a table's main buttons (`data-tt-primary`) move focus between rows.
 * Attach to the table's keydown; keys from other controls are left alone.
 */
export function moveRowFocus(e: {
  key: string
  target: EventTarget
  currentTarget: EventTarget
  preventDefault: () => void
}): void {
  const target = e.target as HTMLElement
  if (!target.hasAttribute('data-tt-primary')) return
  const table = e.currentTarget as HTMLElement
  const all = [...table.querySelectorAll<HTMLElement>('[data-tt-primary]:not(:disabled)')]
  const at = all.indexOf(target)
  let next = -1
  if (e.key === 'ArrowDown') next = Math.min(all.length - 1, at + 1)
  else if (e.key === 'ArrowUp') next = Math.max(0, at - 1)
  else if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = all.length - 1
  if (next < 0) return
  e.preventDefault()
  all[next]?.focus()
}

/** The sort the person chose, kept for the session only (a module value, not storage). */
let sessionSort: SortState = DEFAULT_SORT
export function readSessionSort(): SortState {
  return sessionSort
}
export function writeSessionSort(next: SortState): void {
  sessionSort = next
}
