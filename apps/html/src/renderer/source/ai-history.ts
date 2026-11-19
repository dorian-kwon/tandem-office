import { isolateHistory } from '@codemirror/commands'
import { Transaction, type Annotation } from '@codemirror/state'
import { aiEditUndoHistoryEnabled } from '@genoffice/ui'
import { External } from './cm-setup'

/**
 * Annotations for a programmatic change of the source. `highlight` is true
 * exactly for the edits the AI makes (the person's toolbar and inspector edits,
 * the rollback restore and the blank skeleton pass false), so it also tells
 * which changes must follow the shell's "AI edit undo history" switch: while
 * it is off, an AI edit is kept out of CodeMirror's history. CodeMirror maps
 * the entries already in the history through such a change, so the person's own
 * earlier edits stay undoable.
 */
export function sourceEditAnnotations(highlight: boolean): Annotation<unknown>[] {
  const annotations: Annotation<unknown>[] = [External.of(true), isolateHistory.of('full')]
  if (highlight && !aiEditUndoHistoryEnabled()) {
    annotations.push(Transaction.addToHistory.of(false))
  }
  return annotations
}
