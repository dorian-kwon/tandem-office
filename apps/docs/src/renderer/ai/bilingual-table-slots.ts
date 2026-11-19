import type { Node } from '@tiptap/pm/model'

/** Paragraph numbers in the expanded table, in the same order read_runs lists them. */
export interface BilingualSlots {
  layout: 'right' | 'below'
  sourceToTwin: Map<number, number>
  geometry: string
}

const layouts = new WeakMap<object, BilingualSlots>()
// Text-only undo rebuilds the containing row and table, but shares unaffected
// source paragraphs. Projected nested tables instead have an immutable table model.
const sourceLayouts = new WeakMap<Node, BilingualSlots>()

function geometry(table: Node): string {
  const dimensions: number[] = []
  table.forEach((row) => {
    dimensions.push(row.childCount)
    row.forEach((cell) =>
      dimensions.push(
        Number(cell.attrs.rowspan) || 1,
        Number(cell.attrs.colspan) || 1,
        cell.childCount,
      ),
    )
  })
  return dimensions.join(',')
}

export function rememberBilingualSlots(
  table: Node,
  layout: BilingualSlots['layout'],
  pairs: ReadonlyArray<readonly [Node, Node]>,
): void {
  const ordinals = new Map<Node, number[]>()
  let count = 0
  table.descendants((node) => {
    if (!node.isTextblock) return true
    const found = ordinals.get(node)
    if (found) found.push(count++)
    else ordinals.set(node, [count++])
    return false
  })
  const sourceToTwin = new Map<number, number>()
  for (const [original, empty] of pairs) {
    const source = ordinals.get(original)?.shift(),
      twin = ordinals.get(empty)?.shift()
    if (source === undefined || twin === undefined)
      throw new Error('Cannot locate a bilingual table paragraph')
    sourceToTwin.set(source, twin)
  }
  const slots = { layout, sourceToTwin, geometry: geometry(table) }
  layouts.set(table, slots)
  for (const [source] of pairs) sourceLayouts.set(source, slots)
}

export function linkBilingualSlots(key: object, slots: BilingualSlots): void {
  layouts.set(key, slots)
}

export function bilingualSlots(table: Node, model?: object): BilingualSlots | undefined {
  const known = layouts.get(table) ?? (model && layouts.get(model))
  if (known) return known
  let candidate: BilingualSlots | undefined
  table.descendants((node) => {
    if (!candidate && node.isTextblock) candidate = sourceLayouts.get(node)
    return !candidate && !node.isTextblock
  })
  if (candidate && geometry(table) === candidate.geometry) {
    layouts.set(table, candidate)
    return candidate
  }
}

/** Contents determine completion independently for each destination, including
 * repeated source text and twins that a user revised or emptied. */
export function applySlotRoles(
  slots: BilingualSlots,
  blocks: readonly { node: Node }[],
  roles: Array<'source' | 'twin' | null>,
): void {
  for (const [source, twin] of slots.sourceToTwin) {
    const filled = blocks[twin]?.node.content.size
    roles[source] = filled ? 'source' : null
    roles[twin] = filled ? 'twin' : null
  }
}
