import type { IUndoRedoItem } from '@univerjs/core'

/** Univer limits physical stack entries. A contiguous run of translations uses
 * one slot, but its native undo and redo commands each replay one cell. Keep
 * these plain data so save/reopen can rewrite the workbook IDs as usual. */
interface CellStep {
  item: IUndoRedoItem
  cells: number
}
interface TranslationHistory {
  steps: CellStep[]
  cells: number
}

export function translationHistory(item: object | undefined): TranslationHistory | undefined {
  return (item as { translationHistory?: TranslationHistory } | undefined)?.translationHistory
}

export function newTranslationItem(item: IUndoRedoItem, cells: number): IUndoRedoItem {
  return {
    ...item,
    undoMutations: [],
    redoMutations: [],
    translationHistory: { steps: [{ item, cells }], cells },
  } as IUndoRedoItem
}

interface NativeStacks {
  _getUndoStackForFocused(): IUndoRedoItem[]
  _getRedoStackForFocused(): IUndoRedoItem[]
  _updateStatus(): void
  pitchTopUndoElement(): IUndoRedoItem | undefined
  pitchTopRedoElement(): IUndoRedoItem | undefined
  popUndoToRedo(): void
  popRedoToUndo(): void
}

export function installTranslationHistory(proto: NativeStacks): void {
  const undo = proto.pitchTopUndoElement
  const redo = proto.pitchTopRedoElement
  proto.pitchTopUndoElement = function () {
    const item = undo.call(this)
    return translationHistory(item)?.steps.at(-1)?.item ?? item
  }
  proto.pitchTopRedoElement = function () {
    const item = redo.call(this)
    return translationHistory(item)?.steps.at(-1)?.item ?? item
  }
  const move = (from: IUndoRedoItem[], to: IUndoRedoItem[], source: TranslationHistory) => {
    const step = source.steps.pop()!
    source.cells -= step.cells
    if (!source.steps.length) from.pop()
    const dest = translationHistory(to.at(-1))
    if (dest) {
      dest.steps.push(step)
      dest.cells += step.cells
    } else to.push(newTranslationItem(step.item, step.cells))
  }
  const popUndo = proto.popUndoToRedo
  const popRedo = proto.popRedoToUndo
  proto.popUndoToRedo = function () {
    const source = translationHistory(undo.call(this))
    if (!source) return popUndo.call(this)
    move(this._getUndoStackForFocused(), this._getRedoStackForFocused(), source)
    this._updateStatus()
  }
  proto.popRedoToUndo = function () {
    const source = translationHistory(redo.call(this))
    if (!source) return popRedo.call(this)
    move(this._getRedoStackForFocused(), this._getUndoStackForFocused(), source)
    this._updateStatus()
  }
}
