import type { Editor } from '@tiptap/core'
import type { Node as PmNode } from '@tiptap/pm/model'
import type { Transaction } from '@tiptap/pm/state'
import { ANCHOR_ATTRS, isSavedDocumentReload } from '../save-reload'
import type { AiNotesAccess } from './note-ops'
import { isTrackedDeleted } from './doc-utils'
import {
  groupsOf,
  plainTwinRole,
  noteGroupsOf,
  readNoteRuns,
  runFingerprint,
  tableTwinRoles,
  textblocksOf,
} from './translate-runs'

export type TranslationAddress =
  | { kind: 'body'; index: number; paragraph?: number }
  | { kind: 'note'; note: 'footnote' | 'endnote'; id: string; paragraph?: number }
export interface TranslationRange {
  startBlockIndex: number
  endBlockIndex: number
}
export interface TranslationUnit {
  readonly id: string
  readonly version: number
  readonly segments: readonly string[]
  readonly fp: string
  readonly shape: string
  readonly address: TranslationAddress
}
export interface TranslationUnitIndex {
  snapshot(range?: TranslationRange, includeNotes?: boolean): TranslationUnit[]
  current(id: string): TranslationUnit | undefined
  resolve(expected: TranslationUnit): TranslationUnit | null
  dispose(): void
}
export type TranslationCommit =
  { status: 'applied'; receipt: TranslationUnit } | { status: 'stale' | 'failed'; reason?: string }

interface Extracted {
  node: PmNode
  offset: number
  segments: readonly string[]
  fp: string
  shape: string
}
interface Entry extends Extracted {
  pos: number
  top: PmNode
  unit: TranslationUnit
}
const sameSource = (
  a: Pick<TranslationUnit, 'segments' | 'shape'>,
  b: Pick<TranslationUnit, 'segments' | 'shape'>,
): boolean =>
  a.shape === b.shape &&
  a.segments.length === b.segments.length &&
  a.segments.every((s, i) => s === b.segments[i])

const sourceAttrs = (attrs: PmNode['attrs']): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(attrs).filter(
      ([key]) => key !== 'aiChanged' && !(ANCHOR_ATTRS as readonly string[]).includes(key),
    ),
  )

function paragraphSource(node: PmNode): Pick<Extracted, 'segments' | 'fp' | 'shape'> {
  const groups = groupsOf(node, 0)
  const segments = Object.freeze(groups.map((g) => g.text))
  // Mask only text the executor may replace. Fixed text, whitespace, tabs and atoms stay exact.
  const children: unknown[] = []
  node.forEach((child, offset) => {
    const own = groups.filter((g) => g.from >= 1 + offset && g.to <= 1 + offset + child.nodeSize)
    if (!child.isText || own.length === 0) children.push(child.toJSON())
    else {
      let at = 0
      const parts: unknown[] = []
      for (const group of own) {
        const start = group.from - 1 - offset
        parts.push((child.text ?? '').slice(at, start), { prose: true })
        at = group.to - 1 - offset
      }
      parts.push((child.text ?? '').slice(at))
      children.push(parts)
    }
  })
  return {
    segments,
    fp: runFingerprint(segments),
    shape: JSON.stringify([node.type.name, children]),
  }
}

/** Same source and fixed structure at the same addresses across a trusted save reparse. */
function isCompatibleSavedDocumentReload(transaction: Transaction, current: PmNode): boolean {
  if (!isSavedDocumentReload(transaction)) return false
  const signature = (node: PmNode): unknown => {
    if (node.isTextblock && !isTrackedDeleted(node)) {
      const source = paragraphSource(node)
      return [node.type.name, source.segments, source.shape]
    }
    const children: unknown[] = []
    node.forEach((child) => children.push(signature(child)))
    return [
      node.type.name,
      sourceAttrs(node.attrs),
      node.marks.map((mark) => mark.toJSON()),
      node.text,
      children,
    ]
  }
  const before = JSON.stringify(signature(transaction.before))
  return (
    before === JSON.stringify(signature(transaction.doc)) &&
    (current === transaction.doc || before === JSON.stringify(signature(current)))
  )
}

const verifiedSavedReloads = new WeakSet<Transaction>()
/** Register the editor's unit index before scope listeners so this proof is available to them. */
export const isVerifiedTranslationReload = (transaction: Transaction): boolean =>
  verifiedSavedReloads.has(transaction)

let indexSerial = 0

/** Session-only provenance. Neither signatures nor identities are saved in the document. */
export function createTranslationUnitIndex(
  editor: Editor,
  getNotes?: () => AiNotesAccess | undefined,
): TranslationUnitIndex {
  const namespace = ++indexSerial
  let serial = 0
  let disposed = false
  let entries: Entry[] = []
  let notes = new Map<string, TranslationUnit>()
  const cache = new WeakMap<PmNode, Extracted[]>()
  const paragraphCache = new WeakMap<PmNode, Pick<Extracted, 'segments' | 'fp' | 'shape'>>()
  const make = (
    source: Pick<TranslationUnit, 'segments' | 'fp' | 'shape'>,
    address: TranslationAddress,
    old?: TranslationUnit,
  ): TranslationUnit => {
    const unchanged = old && sameSource(old, source)
    if (unchanged && JSON.stringify(old.address) === JSON.stringify(address)) return old
    return Object.freeze({
      id: old?.id ?? `translation-${namespace}-${++serial}`,
      version: old ? old.version + (unchanged ? 0 : 1) : 1,
      segments: source.segments,
      fp: source.fp,
      shape: source.shape,
      address: Object.freeze(address),
    })
  }
  function extract(top: PmNode): Extracted[] {
    const found = cache.get(top)
    if (found) return found
    const blocks = isTrackedDeleted(top) ? [] : (textblocksOf(top, 0) ?? [])
    const out = blocks.map(({ node, pos }) => {
      let local = paragraphCache.get(node)
      if (!local) {
        local = paragraphSource(node)
        paragraphCache.set(node, local)
      }
      const path: unknown[] = []
      if (top.type.name === 'docTable') {
        const resolved = top.resolve(pos + 1)
        for (let depth = 0; depth < resolved.depth; depth++) {
          const ancestor = resolved.node(depth)
          path.push([ancestor.type.name, sourceAttrs(ancestor.attrs)])
        }
      }
      return {
        node,
        offset: pos,
        segments: local.segments,
        fp: local.fp,
        shape: JSON.stringify([path, local.shape]),
      }
    })
    cache.set(top, out)
    return out
  }
  function refresh(transaction?: Transaction): void {
    if (disposed) return
    const doc = editor.state.doc
    let reset = false
    transaction?.mapping.maps.forEach((map, i) =>
      map.forEach((from, to) => {
        if (from === 0 && to === transaction.docs[i].content.size) reset = true
      }),
    )
    const savedReload = reset && transaction && isCompatibleSavedDocumentReload(transaction, doc)
    const old = reset ? [] : entries
    const oldByNode = new Map<PmNode, Entry[]>()
    for (const e of old) oldByNode.set(e.node, [...(oldByNode.get(e.node) ?? []), e])
    const mapped = new Map<number, Array<{ entry: Entry; end: number }>>()
    if (transaction)
      for (const prior of old) {
        let from = prior.pos
        let to = prior.pos + prior.node.nodeSize
        let valid = true
        for (let i = 0; i < transaction.mapping.maps.length; i++) {
          const map = transaction.mapping.maps[i]
          const start = map.mapResult(from, 1)
          const end = map.mapResult(to, -1)
          if (!start.deleted && !end.deleted) {
            from = start.pos
            to = end.pos
            continue
          }
          // setNodeMarkup replaces the wrapper tokens but preserves the exact immutable
          // content between them. Follow that gap only when both anchors survive and
          // the before/after nodes share their content; recreated equal text is no proof.
          const insideStart = map.mapResult(from + 1, 1)
          const insideEnd = map.mapResult(to - 1, -1)
          const before = transaction.docs[i].nodeAt(from)
          const afterDoc = transaction.docs[i + 1] ?? transaction.doc
          const afterPos = insideStart.pos - 1
          const after = afterPos >= 0 ? afterDoc.nodeAt(afterPos) : null
          if (
            insideStart.deleted ||
            insideEnd.deleted ||
            !before ||
            !after ||
            before.type !== after.type ||
            before.content !== after.content ||
            afterPos + after.nodeSize !== insideEnd.pos + 1
          ) {
            valid = false
            break
          }
          from = afterPos
          to = insideEnd.pos + 1
        }
        if (valid) mapped.set(from, [...(mapped.get(from) ?? []), { entry: prior, end: to }])
      }
    const pending: Array<Omit<Entry, 'unit'> & { index: number; paragraph: number }> = []
    doc.forEach((top, topPos, index) => {
      extract(top).forEach((source, paragraph) =>
        pending.push({
          ...source,
          pos: topPos + source.offset,
          top,
          // Address is derived below so extraction remains independent of document positions.
          index,
          paragraph,
        }),
      )
    })
    if (
      savedReload &&
      pending.length === entries.length &&
      pending.every((entry, i) => {
        const previous = entries[i].unit
        const address = previous.address
        return (
          address.kind === 'body' &&
          address.index === entry.index &&
          address.paragraph ===
            (entry.top.type.name === 'docTable' ? entry.paragraph : undefined) &&
          sameSource(previous, entry)
        )
      })
    ) {
      verifiedSavedReloads.add(transaction!)
      entries = pending.map((entry, i) => ({
        ...entry,
        unit: make(entry, entries[i].unit.address, entries[i].unit),
      }))
      return
    }
    if (reset) notes.clear()
    const newCounts = new Map<PmNode, number>()
    for (const e of pending) newCounts.set(e.node, (newCounts.get(e.node) ?? 0) + 1)
    const used = new Set<string>()
    entries = pending.map((e) => {
      const candidates = oldByNode.get(e.node) ?? []
      let previous =
        candidates.length === 1 && newCounts.get(e.node) === 1 ? candidates[0] : undefined
      if (!previous && transaction) {
        const matching = (mapped.get(e.pos) ?? []).filter(
          (prior) =>
            !used.has(prior.entry.unit.id) &&
            prior.end === e.pos + e.node.nodeSize &&
            prior.entry.node.type === e.node.type,
        )
        if (matching.length === 1) previous = matching[0].entry
      }
      if (previous && used.has(previous.unit.id)) previous = undefined
      if (previous) used.add(previous.unit.id)
      const address: TranslationAddress = {
        kind: 'body',
        index: e.index,
        ...(e.top.type.name === 'docTable' ? { paragraph: e.paragraph } : {}),
      }
      return { ...e, unit: make(e, address, previous?.unit) }
    })
  }
  function body(): TranslationUnit[] {
    const tables = new Map<PmNode, Array<string | null>>()
    for (const e of entries)
      if (e.top.type.name === 'docTable') {
        let fps = tables.get(e.top)
        if (!fps) tables.set(e.top, (fps = []))
        fps.push(e.segments.length ? e.fp : null)
      }
    const tableRoles = new Map([...tables].map(([top, fps]) => [top, tableTwinRoles(editor, fps)]))
    return entries
      .filter((e) => {
        if (!e.segments.length || e.unit.address.kind !== 'body') return false
        const { index, paragraph } = e.unit.address
        return !(paragraph === undefined
          ? plainTwinRole(editor, editor.state.doc, index, e.fp)
          : tableRoles.get(e.top)?.[paragraph])
      })
      .map((e) => e.unit)
  }
  function refreshNotes(): void {
    const access = getNotes?.()
    const next = new Map<string, TranslationUnit>()
    if (access)
      for (const source of readNoteRuns(access)) {
        const key = JSON.stringify([source.note, source.id, source.paragraph])
        const note = access.list(source.note).find((n) => n.id === source.id)
        if (!note) continue
        const { rich, paragraphs } = noteGroupsOf(note)
        const paragraph = source.paragraph ?? 0
        const groups = paragraphs[paragraph].groups
        const runs = rich ? note.richParas![paragraph] : null
        const editable = new Set(groups.map((group) => group.run))
        const shape = JSON.stringify([
          paragraphs.length,
          paragraph,
          rich,
          runs ? runs.map((run, i) => (editable.has(i) ? { prose: true } : run)) : { prose: true },
        ])
        next.set(
          key,
          make(
            { segments: Object.freeze(source.segments), fp: source.fp, shape },
            {
              kind: 'note',
              note: source.note,
              id: source.id,
              ...(source.paragraph === undefined ? {} : { paragraph: source.paragraph }),
            },
            notes.get(key),
          ),
        )
      }
    notes = next
  }
  const onTransaction = ({ transaction }: { transaction: Transaction }): void => {
    if (transaction.docChanged) refresh(transaction)
  }
  refresh()
  editor.on('transaction', onTransaction)
  const current = (id: string): TranslationUnit | undefined => {
    if (disposed) return undefined
    refreshNotes()
    return body().find((u) => u.id === id) ?? [...notes.values()].find((u) => u.id === id)
  }
  return {
    snapshot(range, includeNotes = false) {
      if (disposed) return []
      if (
        range &&
        (!Number.isInteger(range.startBlockIndex) ||
          !Number.isInteger(range.endBlockIndex) ||
          range.startBlockIndex < 0 ||
          range.endBlockIndex < range.startBlockIndex ||
          range.endBlockIndex >= editor.state.doc.childCount)
      )
        throw new RangeError('Invalid translation block range')
      if (range && includeNotes) throw new RangeError('Notes require whole-body scope')
      const out = body().filter(
        (u) =>
          !range ||
          (u.address.kind === 'body' &&
            u.address.index >= range.startBlockIndex &&
            u.address.index <= range.endBlockIndex),
      )
      if (includeNotes) {
        refreshNotes()
        out.push(...notes.values())
      }
      return out
    },
    current,
    resolve(expected) {
      const unit = current(expected.id)
      return unit && unit.version === expected.version && sameSource(unit, expected) ? unit : null
    },
    dispose() {
      disposed = true
      editor.off('transaction', onTransaction)
      entries = []
      notes.clear()
    },
  }
}
