import { matchesElementRef } from '@genoffice/pptx-engine/identity'
import type { Slide, TableElement } from '@genoffice/pptx-engine'
import type { TxnRequest } from '@genoffice/pptx-ops'
import type { Session } from './session-state'

type SlideOp = TxnRequest['ops'][number]
interface TextPatch {
  offset: number
  remove: number
  insert: string
}

/** Table edits already replace one cell's XML in the frame. Save its changed
 * span rather than retaining a copy of the entire table per translated cell. */
function textPatch(from: string, to: string): TextPatch {
  let offset = 0
  while (offset < from.length && offset < to.length && from[offset] === to[offset]) offset++
  let endFrom = from.length,
    endTo = to.length
  while (endFrom > offset && endTo > offset && from[endFrom - 1] === to[endTo - 1]) {
    endFrom--
    endTo--
  }
  // Detach a substring from its much larger backing string. UTF-16 also
  // preserves a patch boundary that happens to bisect a surrogate pair.
  const insert = Buffer.from(to.slice(offset, endTo), 'utf16le').toString('utf16le')
  return { offset, remove: endFrom - offset, insert }
}

type Target =
  | { kind: 'notes' }
  | { kind: 'page'; slide: Slide }
  | {
      kind: 'cell'
      index: number
      row: number
      col: number
      cell: TableElement['rows'][number][number]
      xml: TextPatch
    }
  | { kind: 'element'; index: number; element: Slide['elements'][number] }

export interface TranslationStep {
  page: number
  target: Target
  entries: Map<string, Uint8Array | undefined>
  structureDirty: boolean | undefined
  metaDirty: boolean
}

/** Record only the addressed object. Group XML and outline-level surgery can
 * reparse the page, so those operations checkpoint the page instead. Notes
 * only touch archive parts. Never copy the entire presentation per step. */
export function beforeTranslationStep(
  session: Session,
  op: SlideOp,
  page: number,
): () => TranslationStep {
  const slide = session.opened.deck.slides[page]!
  let target: Target
  let tableXml: string | undefined
  if (op.op === 'setNotes') target = { kind: 'notes' }
  else {
    const index = slide.elements.findIndex((el) => matchesElementRef(el, String(op.target?.el)))
    const pageEdit =
      op.group ||
      index < 0 ||
      (Array.isArray(op.paragraphs) && op.paragraphs.some((p) => p?.level != null))
    const el = slide.elements[index]
    const row = Number(op.row),
      col = Number(op.col)
    if (op.op === 'setTableCell' && el?.type === 'table' && el.rows[row]?.[col]) {
      target = {
        kind: 'cell',
        index,
        row,
        col,
        cell: structuredClone(el.rows[row]![col]!),
        xml: { offset: 0, remove: 0, insert: '' },
      }
      tableXml = el.anchor.originalXml
    } else
      target = pageEdit
        ? { kind: 'page', slide: structuredClone(slide) }
        : { kind: 'element', index, element: structuredClone(slide.elements[index]!) }
  }
  const structureDirty = slide.structureDirty
  const before = new Map(session.opened.archive.entries)
  const metaDirty = !!session.metaDirty
  return () => {
    const entries = new Map<string, Uint8Array | undefined>()
    const after = session.opened.archive.entries
    for (const [path, bytes] of before) if (after.get(path) !== bytes) entries.set(path, bytes)
    for (const path of after.keys()) if (!before.has(path)) entries.set(path, undefined)
    if (target.kind === 'cell' && tableXml !== undefined) {
      target.xml = textPatch(
        session.opened.deck.slides[page]!.elements[target.index]!.anchor.originalXml,
        tableXml,
      )
    }
    return { page, target, entries, metaDirty, structureDirty }
  }
}

/** Swap with current state to produce the exact redo (including layout and
 * package relationships), without running the model's operation again. */
export function swapTranslationStep(session: Session, step: TranslationStep): TranslationStep {
  const slide = session.opened.deck.slides[step.page]!
  const target = step.target
  let reverse = target
  const structureDirty = slide.structureDirty
  if (target.kind === 'page') {
    reverse = { kind: 'page', slide }
    session.opened.deck.slides[step.page] = target.slide
  } else if (target.kind === 'cell') {
    const table = slide.elements[target.index] as TableElement
    reverse = {
      ...target,
      cell: table.rows[target.row]![target.col]!,
      xml: {
        offset: target.xml.offset,
        remove: target.xml.insert.length,
        insert: Buffer.from(
          table.anchor.originalXml.slice(target.xml.offset, target.xml.offset + target.xml.remove),
          'utf16le',
        ).toString('utf16le'),
      },
    }
    table.rows[target.row]![target.col] = target.cell
    table.anchor.originalXml =
      table.anchor.originalXml.slice(0, target.xml.offset) +
      target.xml.insert +
      table.anchor.originalXml.slice(target.xml.offset + target.xml.remove)
  } else if (target.kind === 'element') {
    reverse = { kind: 'element', index: target.index, element: slide.elements[target.index]! }
    slide.elements[target.index] = target.element
  }
  const entries = new Map<string, Uint8Array | undefined>()
  for (const [path, bytes] of step.entries) {
    entries.set(path, session.opened.archive.entries.get(path))
    if (bytes) session.opened.archive.entries.set(path, bytes)
    else session.opened.archive.entries.delete(path)
  }
  const metaDirty = !!session.metaDirty
  session.metaDirty = step.metaDirty
  const restored = session.opened.deck.slides[step.page]!
  if (step.structureDirty === undefined) delete restored.structureDirty
  else restored.structureDirty = step.structureDirty
  return { page: step.page, target: reverse, entries, metaDirty, structureDirty }
}
