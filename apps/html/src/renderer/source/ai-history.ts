import { history, isolateHistory, undoDepth } from '@codemirror/commands'
import { ChangeSet, Transaction, type Annotation } from '@codemirror/state'
import { aiEditUndoHistoryEnabled } from '@genoffice/ui'
import type { EditorView } from '@codemirror/view'
import type { Patch } from '../document/patch'
import { addAiRanges } from './cm-highlight'
import { External, sourceHistory } from './cm-setup'

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

const translationDepths = new WeakMap<EditorView, number>()

/** The compiler already validated all ranges against the original source. The view
 * receives a single update, with one history boundary per translated passage. */
export function applyTranslationPatches(view: EditorView, patches: readonly Patch[]): void {
  const capacity = translationDepths.get(view) ?? 100
  const required = undoDepth(view.state) + patches.length
  if (required > capacity) {
    const minDepth = Math.max(required, capacity * 2)
    view.dispatch({ effects: sourceHistory.reconfigure(history({ minDepth })) })
    translationDepths.set(view, minDepth)
  }
  let state = view.state
  let mapping = ChangeSet.empty(state.doc.length).desc
  const transactions: Transaction[] = []
  for (const patch of patches) {
    const from = mapping.mapPos(patch.from, 1)
    const to = mapping.mapPos(patch.to, -1)
    if (state.sliceDoc(from, to) === patch.text) continue
    const end = from + patch.text.length
    const tr = state.update({
      changes: { from, to, insert: patch.text },
      annotations: sourceEditAnnotations(true),
      effects: addAiRanges.of([[from, end]]),
    })
    transactions.push(tr)
    state = tr.state
    mapping = mapping.composeDesc(tr.changes.desc)
  }
  if (transactions.length) view.dispatch(transactions)
}
