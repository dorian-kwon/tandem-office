import { finishTranslationUnit, visitTranslationUnits } from '../editor/translation-history'
import type { Editor } from '@tiptap/core'
import type { Node, Schema } from '@tiptap/pm/model'
import { EditorState, type Transaction } from '@tiptap/pm/state'
import type { TableModel } from '@genoffice/docx-engine'
import { inlineToRuns, pmTableToModel, tableModelToPmNode, type PmNode } from '../editor/convert'

type Step = { row: number; cell: number; table: number }

export interface NestedTableRef {
  pos: number
  path: Step[]
  model: TableModel
}

/** Tables are numbered depth first inside each top-level block. */
export function nestedTablesOf(block: Node, offset: number): NestedTableRef[] {
  const refs: NestedTableRef[] = []
  const visit = (pos: number, model: TableModel, path: Step[]) => {
    refs.push({ pos, model, path })
    model.rows.forEach((row, r) =>
      row.forEach((cell, c) => {
        if (cell.vMerge === 'continue' || cell.gridGap) return
        cell.nestedTables?.forEach((table, index) =>
          visit(pos, table, [...path, { row: r, cell: c, table: index }]),
        )
      }),
    )
  }
  block.descendants((node, pos) => {
    if (node.type.name !== 'docNestedTable') return true
    const model = node.attrs.model as TableModel | null
    if (model?.rows.length) visit(offset + 1 + pos, model, [])
    return false
  })
  return refs
}

type NestedItem = { index: number; nestedTable?: number }

export function nestedBatches<T extends NestedItem>(items: readonly T[]): T[][] {
  const batches = new Map<string, T[]>()
  for (const item of items) {
    if (item.nestedTable === undefined) continue
    const key = `${item.index}:${item.nestedTable}`
    const existing = batches.get(key)
    if (existing) existing.push(item)
    else batches.set(key, [item])
  }
  // Descendants are written before an ancestor can change its row or column indexes.
  return [...batches.values()].sort((a, b) => b[0].nestedTable! - a[0].nestedTable!)
}

function tableAt(model: TableModel, path: readonly Step[]): TableModel {
  for (const { row, cell, table } of path) model = model.rows[row][cell].nestedTables![table]
  return model
}

function replaceAt(model: TableModel, path: readonly Step[], replacement: TableModel): TableModel {
  const [step, ...rest] = path
  if (!step) return replacement
  const rows = model.rows.slice()
  const row = rows[step.row].slice()
  const cell = row[step.cell]
  const nestedTables = cell.nestedTables!.slice()
  nestedTables[step.table] = replaceAt(nestedTables[step.table], rest, replacement)
  row[step.cell] = { ...cell, nestedTables }
  rows[step.row] = row
  return { ...model, rows }
}

/** Plan a single nested paragraph against the original grid. Resolve its
 * ancestors again on commit so interleaved edits to sibling tables survive. */
export function nestedTextUnit(ref: NestedTableRef, before: TableModel, after: TableModel) {
  const changed: Array<{ r: number; c: number }> = []
  after.rows.forEach((row, r) => {
    if (row !== before.rows[r])
      row.forEach((cell, c) => {
        if (cell !== before.rows[r]![c]) changed.push({ r, c })
      })
  })
  return (tr: Transaction) => {
    const pos = tr.mapping.map(ref.pos)
    const node = tr.doc.nodeAt(pos)!
    const root = node.attrs.model as TableModel
    const current = tableAt(root, ref.path)
    const rows = current.rows.slice()
    for (const { r, c } of changed) {
      if (rows[r] === current.rows[r]) rows[r] = rows[r]!.slice()
      const edited = after.rows[r]![c]!
      rows[r]![c] = { ...rows[r]![c]!, paras: edited.paras, richParas: edited.richParas }
    }
    tr.setNodeMarkup(pos, undefined, {
      ...node.attrs,
      model: replaceAt(root, ref.path, { ...current, rows }),
    })
  }
}

/** Keep all work on the model until the main document transaction is ready. */
export class NestedTableChanges {
  private units: Array<{ pos: number; model: TableModel }> = []
  private roots = new Map<number, TableModel>()
  private lists = new Map<number, NestedTableRef[]>()

  constructor(private readonly doc: Node) {}

  locate(index: number, nestedTable: number): NestedTableRef | undefined {
    let refs = this.lists.get(index)
    if (!refs) {
      if (!Number.isInteger(index) || index < 0 || index >= this.doc.childCount) return
      let pos = 0
      for (let i = 0; i < index; i++) pos += this.doc.child(i).nodeSize
      refs = nestedTablesOf(this.doc.child(index), pos)
      this.lists.set(index, refs)
    }
    const ref = refs[nestedTable]
    if (!ref) return
    const root = this.roots.get(ref.pos)
    return root ? { ...ref, model: tableAt(root, ref.path) } : ref
  }

  set(ref: NestedTableRef, model: TableModel): void {
    const root = this.roots.get(ref.pos) ?? this.doc.nodeAt(ref.pos)!.attrs.model
    const next = replaceAt(root, ref.path, model)
    this.roots.set(ref.pos, next)
    this.units.push({ pos: ref.pos, model: next })
  }

  apply(tr: Transaction): void {
    for (const { pos: before, model } of this.units) {
      const pos = tr.mapping.map(before)
      const node = tr.doc.nodeAt(pos)!
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, model })
      finishTranslationUnit(tr)
    }
  }
}

const projectedTables = new WeakMap<TableModel, WeakMap<Schema, Node>>()

export function nestedTableNode(editor: Editor, model: TableModel): Node {
  let bySchema = projectedTables.get(model)
  if (!bySchema) {
    bySchema = new WeakMap()
    projectedTables.set(model, bySchema)
  }
  const cached = bySchema.get(editor.schema)
  if (cached) return cached
  const node = editor.schema.nodeFromJSON(tableModelToPmNode(model, 0))
  bySchema.set(editor.schema, node)
  return node
}

/** The existing run planners can operate on a detached table without a rendered editor. */
export function draftNestedTable(editor: Editor, model: TableModel) {
  const before = nestedTableNode(editor, model)
  const schema = editor.schema
  let state = EditorState.create({ doc: schema.topNodeType.create(null, [before]) })
  let transaction: Transaction | undefined
  const start = state
  const draft = {
    schema,
    get state() {
      return state
    },
    view: {
      dispatch(tr: Transaction) {
        transaction = tr
        state = state.apply(tr)
      },
    },
  } as unknown as Editor
  return {
    editor: draft,
    forEachResult(structural: boolean, visit: (result: TableModel) => void) {
      if (!transaction) return
      let oldNode = before
      let previous = model
      visitTranslationUnits(transaction, start, (part) => {
        const after = part.doc.firstChild!
        previous = this.result(structural && oldNode === before, after, oldNode, previous)
        visit(previous)
        oldNode = after
      })
    },
    result(
      structural = false,
      after = state.doc.firstChild!,
      oldNode = before,
      previous = model,
    ): TableModel {
      if (after.eq(oldNode)) return previous
      if (structural) return { ...model, ...pmTableToModel(after.toJSON() as PmNode) }
      // Text edits retain the actual model's properties, raw cell XML and
      // unaffected runs, including properties that are only used for rendering.
      const rows = previous.rows.map((cells, r) => {
        const oldRow = oldNode.child(r)
        const newRow = after.child(r)
        if (oldRow.eq(newRow)) return cells
        let c = 0
        return cells.map((cell) => {
          if (cell.vMerge === 'continue') return cell
          const oldCell = oldRow.child(c)
          const newCell = newRow.child(c++)
          if (oldCell.eq(newCell)) return cell
          const paras = cell.paras.slice()
          const richParas =
            cell.richParas?.slice() ??
            paras.map((text) => ({
              runs: text ? [{ text, bold: cell.bold, color: cell.color }] : [],
            }))
          let p = 0
          newCell.forEach((node, _offset, i) => {
            if (!node.isTextblock) return
            const index = p++
            if (node.content.eq(oldCell.child(i).content)) return
            const runs = inlineToRuns((node.toJSON() as PmNode).content ?? [])
            richParas[index] = { ...richParas[index], runs }
            paras[index] = runs.map((run) => run.text).join('')
          })
          return { ...cell, paras, richParas }
        })
      })
      return { ...previous, rows }
    },
  }
}
