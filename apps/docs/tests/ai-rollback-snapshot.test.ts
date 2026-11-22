import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { applyAiPanelPrefs } from '@genoffice/ui'
import { Editor } from '@tiptap/core'
import { aiEditor } from '../src/renderer/ai/ai-history-gate'
import { editorExtensions } from '../src/renderer/editor/extensions'
import {
  captureRollbackSnapshot,
  restoreRollbackSnapshot,
} from '../src/renderer/ai/rollback-snapshot'

/**
 * The roll-back point of an AI run is the document node itself. It must bring
 * the document back exactly, share the untouched blocks with later documents
 * instead of copying them, and leave later edits from outside the chat intact.
 */

function para(index: number, text: string) {
  return {
    type: 'docParagraph',
    attrs: { docxIndex: index },
    content: [{ type: 'text', text }],
  }
}

function createEditor(): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: {
      type: 'doc',
      content: [para(0, 'First block'), para(1, 'Second block'), para(2, 'Third block')],
    },
  })
}

beforeEach(() => applyAiPanelPrefs({ aiEditUndoHistory: true }))
afterEach(() => applyAiPanelPrefs({ aiEditUndoHistory: false }))

describe('AI roll-back snapshot', () => {
  it('restores the document as it was before the run', () => {
    const editor = createEditor()
    const before = editor.getJSON()
    const snapshot = captureRollbackSnapshot(editor)
    aiEditor(editor).commands.insertContentAt(
      editor.state.doc.content.size,
      para(3, 'Added by the AI'),
    )
    aiEditor(editor).commands.insertContentAt(1, 'Edited ')
    const after = editor.getJSON()
    expect(after).not.toEqual(before)
    editor.storage.trackChanges.enabled = true
    restoreRollbackSnapshot(editor, snapshot)
    expect(editor.getJSON()).toEqual(before)
    expect(editor.state.doc.eq(snapshot.doc)).toBe(true)
    expect(editor.commands.redo()).toBe(true)
    expect(editor.commands.redo()).toBe(true)
    expect(editor.getJSON()).toEqual(after)
    editor.destroy()
  })

  it('separates touching edits from consecutive chat turns in native history', () => {
    const editor = createEditor()
    captureRollbackSnapshot(editor)
    aiEditor(editor).commands.insertContentAt(1, 'A')
    const correction = captureRollbackSnapshot(editor)
    aiEditor(editor).commands.insertContentAt(2, 'B')
    expect(restoreRollbackSnapshot(editor, correction)).toBe(true)
    expect(editor.state.doc.firstChild?.textContent).toBe('AFirst block')
    expect(editor.commands.undo()).toBe(true)
    expect(editor.state.doc.firstChild?.textContent).toBe('First block')
    editor.destroy()
  })

  it('shares the blocks the run left alone instead of copying them', () => {
    const editor = createEditor()
    const snapshot = captureRollbackSnapshot(editor)
    editor.commands.insertContentAt(1, 'Edited ')
    const live = editor.state.doc
    expect(live.child(0)).not.toBe(snapshot.doc.child(0))
    expect(live.child(1)).toBe(snapshot.doc.child(1))
    expect(live.child(2)).toBe(snapshot.doc.child(2))
    editor.destroy()
  })

  it.each(['typing', 'MCP'])('preserves %s between two edits of the same run', (source) => {
    const editor = createEditor()
    const snapshot = captureRollbackSnapshot(editor)
    aiEditor(editor).commands.insertContentAt(1, 'AI ')
    if (source === 'typing') editor.commands.insertContentAt(1, 'My edit ')
    else aiEditor(editor, 'mcp').commands.insertContentAt(1, 'External ')
    aiEditor(editor).commands.insertContentAt(1, 'AI again ')
    const before = editor.state.doc
    expect(restoreRollbackSnapshot(editor, snapshot)).toBe(false)
    expect(editor.state.doc).toBe(before)
    editor.destroy()
  })

  it('does not revive a checkpoint across an unrecorded AI edit', () => {
    const editor = createEditor()
    const snapshot = captureRollbackSnapshot(editor)
    applyAiPanelPrefs({ aiEditUndoHistory: false })
    aiEditor(editor).commands.insertContentAt(1, 'Unrecorded ')
    applyAiPanelPrefs({ aiEditUndoHistory: true })
    aiEditor(editor).commands.insertContentAt(1, 'Recorded ')
    expect(restoreRollbackSnapshot(editor, snapshot)).toBe(false)
    expect(editor.state.doc.textContent).toContain('Recorded Unrecorded ')
    editor.destroy()
  })

  it('leaves a replacement editor alone', () => {
    const first = createEditor()
    const snapshot = captureRollbackSnapshot(first)
    first.destroy()
    const second = createEditor()
    second.commands.insertContentAt(1, 'Changed ')
    expect(second.schema).not.toBe(snapshot.doc.type.schema)
    expect(restoreRollbackSnapshot(second, snapshot)).toBe(false)
    expect(second.state.doc.textContent).toContain('Changed ')
    second.destroy()
  })
})
