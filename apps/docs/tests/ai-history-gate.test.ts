import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it } from 'vitest'
import { applyAiPanelPrefs } from '@genoffice/ui'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { aiEditor, aiEditInFlight, withAiEdit } from '../src/renderer/ai/ai-history-gate'

const para = (index: number, text: string) => ({
  type: 'docParagraph',
  attrs: { docxIndex: index },
  content: [{ type: 'text', text }],
})

function createEditor(): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: { type: 'doc', content: [para(0, 'First'), para(1, 'Second')] } as never,
  })
}

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

afterEach(() => applyAiPanelPrefs({ aiEditUndoHistory: false }))

describe('AI edit undo history in the Word editor', () => {
  it('keeps no undo entry for an AI tool edit while the setting is off', () => {
    applyAiPanelPrefs({ aiEditUndoHistory: false })
    const editor = createEditor()
    withAiEdit(() => editor.commands.insertContentAt(1, 'AI '))
    expect(editor.state.doc.textContent).toContain('AI First')
    expect(editor.can().undo()).toBe(false)
    editor.destroy()
  })

  it('keeps the person edits undoable and leaves the AI edit in place when undoing them', () => {
    applyAiPanelPrefs({ aiEditUndoHistory: false })
    const editor = createEditor()
    editor.commands.insertContentAt(editor.state.doc.content.size, para(2, 'Mine'))
    withAiEdit(() => editor.commands.insertContentAt(1, 'AI '))
    expect(editor.can().undo()).toBe(true)
    editor.commands.undo()
    expect(editor.state.doc.textContent).toContain('AI First')
    expect(editor.state.doc.textContent).not.toContain('Mine')
    editor.destroy()
  })

  it('records the AI edit as usual while the setting is on', () => {
    applyAiPanelPrefs({ aiEditUndoHistory: true })
    const editor = createEditor()
    withAiEdit(() => editor.commands.insertContentAt(1, 'AI '))
    expect(editor.can().undo()).toBe(true)
    editor.commands.undo()
    expect(editor.state.doc.textContent).not.toContain('AI ')
    editor.destroy()
  })

  it('does not touch an edit made outside an AI tool call, whatever the setting', () => {
    applyAiPanelPrefs({ aiEditUndoHistory: false })
    const editor = createEditor()
    editor.commands.insertContentAt(1, 'Me ')
    expect(editor.can().undo()).toBe(true)
    editor.destroy()
  })

  it('keeps a paste made by the person while a tool runs', () => {
    applyAiPanelPrefs({ aiEditUndoHistory: false })
    const editor = createEditor()
    withAiEdit(() =>
      editor.view.dispatch(editor.state.tr.insertText('P ', 1).setMeta('uiEvent', 'paste')),
    )
    expect(editor.can().undo()).toBe(true)
    editor.destroy()
  })

  it('keeps typing and toolbar edits during an awaited AI call, tagging only its later commit', async () => {
    const editor = createEditor()
    const ai = aiEditor(editor)
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = withAiEdit(async () => {
      await barrier
      ai.chain().insertContentAt(1, 'AI ').run()
    })
    expect(aiEditInFlight()).toBe(false)
    editor.commands.insertContentAt(editor.state.doc.content.size, para(2, 'Mine'))
    release()
    await pending
    editor.commands.undo()
    expect(editor.state.doc.textContent).toContain('AI First')
    expect(editor.state.doc.textContent).not.toContain('Mine')
    expect(editor.can().undo()).toBe(false)
    await expect(withAiEdit(() => Promise.reject(new Error('x')))).rejects.toThrow('x')
    expect(aiEditInFlight()).toBe(false)
    editor.destroy()
  })

  it.each([false, true])(
    'isolates adjacent manual edits on both sides of the AI (history %s)',
    (on) => {
      applyAiPanelPrefs({ aiEditUndoHistory: on })
      const editor = createEditor()
      editor.commands.insertContentAt(1, 'A')
      aiEditor(editor).commands.insertContentAt(2, 'B')
      editor.commands.insertContentAt(3, 'C')
      const nativeUndo = () =>
        editor.view.dom.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }),
        )
      nativeUndo()
      expect(editor.state.doc.firstChild?.textContent).toBe('ABFirst')
      if (on) {
        editor.commands.undo()
        expect(editor.state.doc.firstChild?.textContent).toBe('AFirst')
      }
      nativeUndo()
      expect(editor.state.doc.firstChild?.textContent).toBe(on ? 'First' : 'BFirst')
      while (editor.can().redo()) editor.commands.redo()
      expect(editor.state.doc.firstChild?.textContent).toBe('ABCFirst')
      editor.destroy()
    },
  )

  it('wires the agent skill and the rollback button to the setting', () => {
    expect(src('../src/renderer/ai/docs-skill.ts')).toContain('withAiEdit(')
    const panel = src('../src/renderer/ai/AiPanel.tsx')
    expect(panel).toContain(
      'aiEditUndoHistoryEnabled() && snapshotBefore && !runSnapshotRef.current',
    )
    expect(panel).toMatch(/captureSnapshot: \(\) =>\s*aiEditUndoHistoryEnabled\(\)/)
  })
})
