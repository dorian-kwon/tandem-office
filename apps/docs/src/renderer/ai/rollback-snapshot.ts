import { aiEditUndoHistoryEnabled } from '@genoffice/ui'
import type { Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import {
  markAiHistoryBoundary,
  rollbackCheckpoint,
  rollbackFileBaseline,
  withAiEdit,
} from './ai-history-gate'
import { closeHistory, undo, undoDepth } from '@tiptap/pm/history'
import { sameDocAcrossSave } from '../save-reload'
import { TRACK_IGNORE } from '../editor/revisions'
import { TABLE_TRAILING_SKIP } from '../editor/extensions'

/**
 * The roll-back point of an AI run: the document node itself, not a JSON copy.
 * The node is immutable and shares every part the run leaves untouched with the
 * live document, so keeping it costs about what changed after it. The agent
 * loop asks for one before each tool until the run's first edit, so a run that
 * reads several times before editing no longer copies the whole document each
 * time.
 */
export interface RollbackSnapshot {
  doc: ProseMirrorNode
  depth: number
  fileBaseline?: object
  checkpoint: object | undefined
}

export function captureRollbackSnapshot(editor: Editor): RollbackSnapshot {
  markAiHistoryBoundary(editor)
  return {
    doc: editor.state.doc,
    depth: undoDepth(editor.state),
    checkpoint: rollbackCheckpoint(editor),
    fileBaseline: rollbackFileBaseline(editor),
  }
}

export function canRestoreRollbackSnapshot(editor: Editor, snapshot: RollbackSnapshot): boolean {
  return (
    aiEditUndoHistoryEnabled() &&
    snapshot.checkpoint !== undefined &&
    snapshot.checkpoint === rollbackCheckpoint(editor) &&
    (snapshot.depth !== undoDepth(editor.state) ||
      (snapshot.doc !== editor.state.doc && !sameDocAcrossSave(editor.state.doc, snapshot.doc)))
  )
}

/** Recheck at dispatch time: an edit can arrive after the button was rendered. */
export function restoreRollbackSnapshot(editor: Editor, snapshot: RollbackSnapshot): boolean {
  if (!canRestoreRollbackSnapshot(editor, snapshot)) return false
  // Plan against the actual native history first. A compacted event or an
  // earlier chat edit merged across this checkpoint must not overshoot it.
  const plugin = editor.state.plugins.find((p) =>
    String((p as unknown as { key: string }).key).startsWith('history$'),
  )
  if (plugin) {
    let shadow = editor.state.reconfigure({ plugins: [plugin] })
    const tr = editor.state.tr
    const reached = () =>
      undoDepth(shadow) === snapshot.depth && sameDocAcrossSave(shadow.doc, snapshot.doc)
    while (
      undoDepth(shadow) > snapshot.depth &&
      undo(shadow, (part) => {
        for (const step of part.steps) tr.step(step)
        tr.setMeta(plugin, part.getMeta(plugin))
        shadow = shadow.apply(part)
      })
    ) {
      /* walk one native event at a time */
    }
    if (reached()) {
      tr.setSelection(shadow.selection.getBookmark().resolve(tr.doc))
      tr.setMeta(TRACK_IGNORE, true).setMeta(TABLE_TRAILING_SKIP, true)
      editor.view.dispatch(tr)
      return true
    }
  }
  // A fallback replacement would put stale file anchors into the new save baseline.
  if (snapshot.fileBaseline !== rollbackFileBaseline(editor)) return false
  withAiEdit(() =>
    editor
      .chain()
      .command(({ tr }) => {
        closeHistory(tr)
        return true
      })
      .setMeta(TRACK_IGNORE, true)
      .setMeta(TABLE_TRAILING_SKIP, true)
      .setContent(snapshot.doc)
      .run(),
  )
  return editor.state.doc.eq(snapshot.doc)
}
