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

/** Rows per page of the project list. */
export const PROJECT_PAGE_SIZE = 10

/**
 * The entries whose name, folder or language pair contains every word of `query`
 * (case-insensitive); an empty query keeps all. `pairText` gives the pair's display text.
 */
export function filterProjects(
  list: readonly TranslateProjectListEntry[],
  query: string,
  pairText: (entry: TranslateProjectListEntry) => string,
): TranslateProjectListEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...list]
  return list.filter((entry) => {
    const hay = `${entry.name}\n${entry.dir}\n${pairText(entry)}`.toLowerCase()
    return words.every((word) => hay.includes(word))
  })
}

export interface PageSlice<T> {
  items: T[]
  /** the page actually shown, 0-based, clamped into range */
  page: number
  pageCount: number
  /** 1-based inclusive range of the shown items; 0 when empty */
  from: number
  to: number
  total: number
}

/** One page of `list`; a page past the end (after a search or a delete) clamps to the last. */
export function paginate<T>(list: readonly T[], page: number, size: number): PageSlice<T> {
  const total = list.length
  const pageCount = Math.max(1, Math.ceil(total / size))
  const at = Math.min(Math.max(0, page), pageCount - 1)
  const items = list.slice(at * size, at * size + size)
  return {
    items,
    page: at,
    pageCount,
    from: total === 0 ? 0 : at * size + 1,
    to: at * size + items.length,
    total,
  }
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
