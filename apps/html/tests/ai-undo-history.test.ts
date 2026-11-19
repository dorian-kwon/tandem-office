import { afterEach, describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { redo, undo, undoDepth } from '@codemirror/commands'
import { applyAiPanelPrefs, normalizeAiPanelPrefs } from '@genoffice/ui'
import { buildExtensions, External } from '../src/renderer/source/cm-setup'
import { applyTranslationPatches, sourceEditAnnotations } from '../src/renderer/source/ai-history'

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
  it('retains every translated passage beyond CodeMirror’s default history depth', () => {
    setHistory(true)
    const view = makeView('a'.repeat(160))
    for (let start = 0; start < 160; start += 40) {
      applyTranslationPatches(
        view,
        Array.from({ length: 40 }, (_, i) => ({ from: start + i, to: start + i + 1, text: 'b' })),
      )
    }
    expect(undoDepth(view.state)).toBe(160)
    for (let i = 0; i < 160; i++) expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('a'.repeat(160))
  })

  it('keeps the order of translated passages, including different lengths and surrounding typing', () => {
    setHistory(true)
    const view = makeView('one/two/three')
    view.dispatch({ changes: { from: 3, insert: '!' }, userEvent: 'input.type' })
    applyTranslationPatches(view, [
      { from: 9, to: 14, text: '셋' },
      { from: 5, to: 8, text: 'two' },
      { from: 0, to: 3, text: '하나' },
    ])
    view.dispatch({ changes: { from: 0, insert: '?' }, userEvent: 'input.type' })
    for (const source of ['하나!/two/셋', 'one!/two/셋', 'one!/two/three', 'one/two/three']) {
      expect(undo(view)).toBe(true)
      expect(view.state.doc.toString()).toBe(source)
    }
    for (const source of ['one!/two/three', 'one!/two/셋', '하나!/two/셋', '?하나!/two/셋']) {
      expect(redo(view)).toBe(true)
      expect(view.state.doc.toString()).toBe(source)
    }
  })

  it('always marks the edit as coming from outside the typing path', () => {
    setHistory(false)
    expect(sourceEditAnnotations(true).some((a) => a.type === External)).toBe(true)
    expect(sourceEditAnnotations(false).some((a) => a.type === External)).toBe(true)
  })

  it.each([false, true])(
    'separates typing on both sides of an AI patch (history %s)',
    (enabled) => {
      setHistory(enabled)
      const view = makeView('abc')
      view.dispatch({ changes: { from: 1, insert: 'H' }, userEvent: 'input.type' })
      view.dispatch({
        changes: { from: 2, insert: 'AI' },
        annotations: sourceEditAnnotations(true),
      })
      view.dispatch({ changes: { from: 4, insert: 'M' }, userEvent: 'input.type' })
      expect(undo(view)).toBe(true)
      expect(view.state.doc.toString()).toBe('aHAIbc')
      if (enabled) {
        expect(undo(view)).toBe(true)
        expect(view.state.doc.toString()).toBe('aHbc')
      }
      expect(undo(view)).toBe(true)
      expect(view.state.doc.toString()).toBe(enabled ? 'abc' : 'aAIbc')
      expect(redo(view)).toBe(true)
      if (enabled) expect(redo(view)).toBe(true)
      expect(redo(view)).toBe(true)
      expect(view.state.doc.toString()).toBe('aHAIMbc')
    },
  )

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
