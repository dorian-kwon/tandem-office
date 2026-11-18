import { afterEach, describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { undo, undoDepth } from '@codemirror/commands'
import { applyAiPanelPrefs, normalizeAiPanelPrefs } from '@genoffice/ui'
import { buildExtensions, External } from '../src/renderer/source/cm-setup'
import { sourceEditAnnotations } from '../src/renderer/source/ai-history'

function setHistory(enabled: boolean): void {
  applyAiPanelPrefs(normalizeAiPanelPrefs({ aiEditUndoHistory: enabled }))
}

const views: EditorView[] = []

/** detached from the document: jsdom has no layout for CodeMirror to measure */
function makeView(doc: string): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: buildExtensions(() => undefined) }),
  })
  views.push(view)
  return view
}

/** what SourceEditor.applyPatches dispatches for one replacement */
function replaceFirst(view: EditorView, text: string, highlight: boolean): void {
  view.dispatch({
    changes: { from: 0, to: 1, insert: text },
    annotations: sourceEditAnnotations(highlight),
  })
}

afterEach(() => {
  setHistory(false)
  for (const view of views.splice(0)) view.destroy()
})

describe('source edit annotations', () => {
  it('always marks the edit as coming from outside the typing path', () => {
    setHistory(false)
    expect(sourceEditAnnotations(true).some((a) => a.type === External)).toBe(true)
    expect(sourceEditAnnotations(false).some((a) => a.type === External)).toBe(true)
  })

  it('keeps no undo entry for an AI edit while the setting is off', () => {
    setHistory(false)
    const view = makeView('abc')
    replaceFirst(view, 'X', true)
    expect(view.state.doc.toString()).toBe('Xbc')
    expect(undoDepth(view.state)).toBe(0)
  })

  it('keeps the undo entry for an AI edit when the setting is on', () => {
    setHistory(true)
    const view = makeView('abc')
    replaceFirst(view, 'X', true)
    expect(undoDepth(view.state)).toBe(1)
    undo(view)
    expect(view.state.doc.toString()).toBe('abc')
  })

  it('never drops a person-made (non-highlighted) edit, whatever the setting says', () => {
    setHistory(false)
    const view = makeView('abc')
    replaceFirst(view, 'X', false)
    expect(undoDepth(view.state)).toBe(1)
  })

  it('leaves the person edits beneath an AI edit undoable when history is off', () => {
    setHistory(false)
    const view = makeView('abc')
    view.dispatch({ changes: { from: 3, insert: '!' }, userEvent: 'input.type' })
    replaceFirst(view, 'X', true)
    expect(undoDepth(view.state)).toBe(1)
    undo(view)
    // the person's earlier edit is the one undone; the AI edit stays
    expect(view.state.doc.toString()).toBe('Xbc')
  })
})
