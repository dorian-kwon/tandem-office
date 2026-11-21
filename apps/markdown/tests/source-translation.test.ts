import { afterEach, beforeEach, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history, undo, redo, undoDepth } from '@codemirror/commands'
import { applyAiPanelPrefs } from '@genoffice/ui'
import { SourceTranslation } from '../src/renderer/source/translation'

let view: EditorView
beforeEach(() => applyAiPanelPrefs({ aiEditUndoHistory: true }))
afterEach(() => {
  view?.destroy()
  applyAiPanelPrefs({ aiEditUndoHistory: true })
})

it.each(['txt', 'json'])(
  'resumes a batch against the live %s document after undo and manual editing',
  (ext) => {
    const json = ext === 'json'
    const originals = Array.from({ length: 120 }, (_, i) => 'same source ' + (i % 2))
    const document = (values: string[]) =>
      json ? JSON.stringify({ items: values }, null, 2) : values.join('\n')
    view = new EditorView({
      state: EditorState.create({
        doc: document(originals),
        extensions: [history({ minDepth: 200 })],
      }),
    })
    const source = new SourceTranslation(view, json)
    const run = (name: string, input: Record<string, unknown>) =>
      source.execute({ id: 'test', name, input: { language: 'en', ...input } })
    const items = originals.map((text, id) => ({
      id,
      source: text,
      translation: 'Translation "' + id + '"',
    }))
    const write = (group: typeof items) => run('translate_source_units', { items: group })
    const pending = () =>
      JSON.parse(run('read_source_units', { remaining: true }).output).units as { id: number }[]
    const first = write(items.slice(0, 70))
    expect(first.isError).toBeFalsy()
    expect(first.translationProgress).toEqual({ done: 70, total: 120 })
    expect(write(items.slice(0, 1)).translationProgress).toBeUndefined()
    expect(first.changeLocations?.[1]).toEqual({ kind: 'source', index: 1 })
    source.showUnit(1)
    const selected = view.state.sliceDoc(
      view.state.selection.main.from,
      view.state.selection.main.to,
    )
    expect(json ? JSON.parse(selected) : selected).toBe(items[1]!.translation)
    expect(pending().map((x) => x.id)).toEqual(items.slice(70).map((x) => x.id))
    expect(write(items.slice(70)).translationProgress).toEqual({ done: 120, total: 120 })
    expect(undoDepth(view.state)).toBe(120)
    expect(pending()).toEqual([])
    for (let i = 119; i >= 0; i--) {
      expect(undo(view)).toBe(true)
      expect(view.state.doc.toString()).toBe(
        document(items.map((r, j) => (j < i ? r.translation : r.source))),
      )
    }
    for (let i = 0; i < 120; i++) expect(redo(view)).toBe(true)
    expect(pending()).toEqual([])
    expect(undo(view)).toBe(true)
    expect(pending().map((x) => x.id)).toEqual([119])
    expect(run('read_source_units', {}).translationProgress).toEqual({ done: 119, total: 120 })
    expect(run('read_source_units', { language: 'fr' }).translationProgress).toEqual({
      done: 0,
      total: 120,
    })
    const last = view.state.doc.toString().lastIndexOf(originals[119]!)
    view.dispatch({ changes: { from: last, to: last + originals[119]!.length, insert: 'manual' } })
    const before = view.state.doc
    expect(write([items[119]!]).isError).toBe(true)
    expect(view.state.doc).toBe(before)
  },
)
