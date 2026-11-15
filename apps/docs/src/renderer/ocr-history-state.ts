import type { PmNode } from './editor/convert'
import type { DocState } from './doc-state'

/**
 * What undo and redo of OCR text put into the open document need to remember, apart from the code
 * that does it: the keyboard shortcuts, a save and opening another document only reach this small
 * module, never the editor modules that would make an import loop.
 */

export interface OcrSnapshot {
  pm: PmNode
  doc: DocState
  dirty: boolean
}
export interface OcrHistory {
  before: OcrSnapshot
  after: OcrSnapshot | null
  /** the OCR text is in the document now (false after an undo) */
  applied: boolean
  /** the document as it stood right after an undo: redo is only good while it is unchanged */
  restored: unknown
}

let history: OcrHistory | null = null
export const getOcrHistory = (): OcrHistory | null => history
export const setOcrHistory = (next: OcrHistory | null): void => {
  history = next
}
/** forget what undo and redo could bring back: the document was saved or another one was opened */
export const clearOcrHistory = (): void => {
  history = null
}

export interface OcrHistoryHandlers {
  /** true when the key was taken: the OCR text was undone */
  undo: () => boolean
  redo: () => boolean
}
let handlers: OcrHistoryHandlers | null = null
/** the window registers what its context makes of undo and redo; null removes it */
export const registerOcrHistoryHandlers = (next: OcrHistoryHandlers | null): void => {
  handlers = next
}
export const runOcrUndo = (): boolean => handlers?.undo() ?? false
export const runOcrRedo = (): boolean => handlers?.redo() ?? false
