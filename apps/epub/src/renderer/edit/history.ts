import { ChangeSet, type ChangeDesc } from '@codemirror/state'
import type { RangeReplacement } from '@genoffice/epub-engine'

export interface HistoryPart {
  length: number
  spineIndex: number
  path: string
  /** the replacements that undo the change, against the chapter text right after it */
  inverse: RangeReplacement[]
}

export interface HistoryEntry {
  translation?: boolean
  parts: HistoryPart[]
}

function inverseMap(part: HistoryPart): ChangeDesc {
  // Only the offsets are needed. An explicit separator preserves the length of CRLF source.
  return ChangeSet.of(
    part.inverse.map((r) => ({ from: r.start, to: r.end, insert: r.text })),
    part.length,
    '\n',
  ).desc
}

export function forwardChanges(parts: HistoryPart[]): Map<string, ChangeDesc> {
  const changes = new Map<string, ChangeDesc>()
  for (const part of parts) {
    const forward = inverseMap(part).invertedDesc
    const previous = changes.get(part.path)
    changes.set(part.path, previous ? previous.composeDesc(forward) : forward)
  }
  return changes
}

/** Rebase the earlier undo entries through a change excluded from history. */
export function mapHistory(
  entries: HistoryEntry[],
  initial: ReadonlyMap<string, ChangeDesc>,
): void {
  let changes = new Map(initial)
  for (const entry of [...entries].reverse()) {
    if (!entry.parts.some((p) => changes.has(p.path))) continue
    const next = new Map(changes)
    const parts: HistoryPart[] = []
    let conflict = false
    for (const part of [...entry.parts].reverse()) {
      const change = next.get(part.path)
      if (!change) {
        parts.push(part)
        continue
      }
      change.iterChangedRanges((start, end) => {
        // Adjacent replacements commute. Two insertions at the very same
        // offset lack an unambiguous order in chapter source.
        if (
          part.inverse.some(
            (r) =>
              (start < r.end && end > r.start) ||
              (start === end && r.start === start && r.end === end),
          )
        )
          conflict = true
      })
      if (conflict) break
      parts.push({
        ...part,
        length: change.newLength,
        inverse: part.inverse.map((r) => ({
          ...r,
          start: change.mapPos(r.start, 1),
          end: change.mapPos(r.end, -1),
        })),
      })
      // Older entries are relative to the chapter before this inverse's edit.
      next.set(part.path, change.mapDesc(inverseMap(part)))
    }
    if (conflict) {
      // Refuse the entire entry on undo. Its edits stay in the book, including
      // any other chapters it changed, so map older entries through those too.
      for (const part of [...entry.parts].reverse()) {
        const forward = inverseMap(part).invertedDesc
        const change = changes.get(part.path)
        changes.set(part.path, change ? forward.composeDesc(change) : forward)
      }
      entry.parts = []
    } else {
      entry.parts = parts.reverse()
      changes = next
    }
  }
}
