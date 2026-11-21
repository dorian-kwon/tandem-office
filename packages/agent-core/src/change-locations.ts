/** Compact, editor-owned destinations for the local chat receipt. */
export type AiChangeLocation =
  | { kind: 'block'; index: number; token: number }
  | { kind: 'source' | 'page' | 'element'; index: number }
  | { kind: 'slide'; part: string; index: number; node?: string }
  | { kind: 'cell'; id: string; sheet: string; range: string }
  | { kind: 'book'; chapter: number; block: string }
  | { kind: 'topic'; sheet: string; topic: string; label: string }

export const MAX_CHANGE_LOCATIONS = 24

function locationKey(place: AiChangeLocation): string {
  return place.kind === 'topic' ? JSON.stringify([place.sheet, place.topic]) : JSON.stringify(place)
}

/** Merge the local side channel into the current assistant message, including partial successes. */
export function changeLocationPatch(
  message: { changeLocations?: readonly AiChangeLocation[] },
  execution: { mutated?: boolean; changeLocations?: readonly AiChangeLocation[] },
): { changeLocations?: readonly AiChangeLocation[] } {
  if (!execution.mutated || !execution.changeLocations?.length) return {}
  return {
    changeLocations: mergeChangeLocations(message.changeLocations, execution.changeLocations),
  }
}

/** Bound the receipt independently of undo history and the number of translated units. */
export function mergeChangeLocations(
  previous: readonly AiChangeLocation[] | undefined,
  added: Iterable<AiChangeLocation>,
): AiChangeLocation[] {
  const result = [...(previous ?? [])]
  const seen = new Set(result.map(locationKey))
  for (const location of added) {
    if (result.length >= MAX_CHANGE_LOCATIONS) break
    const key = locationKey(location)
    if (seen.has(key)) continue
    result.push(location)
    seen.add(key)
  }
  return result
}

/** ProseMirror shares unchanged child nodes between immutable document versions. */
interface BlockList {
  readonly childCount: number
  child(index: number): object
}

const blockTokens = new WeakMap<object, number>()
let nextBlockToken = 0
function tokenOf(block: object): number {
  const old = blockTokens.get(block)
  if (old !== undefined) return old
  blockTokens.set(block, ++nextBlockToken)
  return nextBlockToken
}

export function changedBlockLocations(before: BlockList, after: BlockList): AiChangeLocation[] {
  if (before === after) return []
  let start = 0
  let oldEnd = before.childCount
  let end = after.childCount
  while (start < oldEnd && start < end && before.child(start) === after.child(start)) start++
  while (oldEnd > start && end > start && before.child(oldEnd - 1) === after.child(end - 1)) {
    oldEnd--
    end--
  }
  if (start === end) return []
  const old = new Set<object>()
  if (oldEnd !== end) {
    for (let index = start; index < oldEnd; index++) old.add(before.child(index))
  }
  const places: AiChangeLocation[] = []
  for (let index = start; index < end && places.length < MAX_CHANGE_LOCATIONS; index++) {
    const block = after.child(index)
    if (oldEnd === end ? before.child(index) === block : old.has(block)) continue
    places.push({ kind: 'block', index, token: tokenOf(block) })
  }
  return places
}

/** Follow a surviving block when earlier blocks were inserted, and ignore removed blocks. */
export function findChangedBlock(
  doc: BlockList,
  place: Extract<AiChangeLocation, { kind: 'block' }>,
): number | null {
  if (place.index < doc.childCount && blockTokens.get(doc.child(place.index)) === place.token)
    return place.index
  for (let i = 0; i < doc.childCount; i++)
    if (blockTokens.get(doc.child(i)) === place.token) return i
  return null
}

/** Removing an AI highlight changes only the wrapper around a surviving block. */
export function keepBlockLocation(before: object, after: object): void {
  const token = blockTokens.get(before)
  if (token !== undefined) blockTokens.set(after, token)
}
