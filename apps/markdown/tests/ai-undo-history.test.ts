import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { undoDepth } from '@tiptap/pm/history'
import { applyAiPanelPrefs } from '@genoffice/ui'
import { buildExtensions } from '../src/renderer/editor/extensions'
import { runOps, uiOp } from '../src/renderer/editor/ops'
import { executeTool } from '../src/renderer/ai/tools'
import type { AiDocWriter } from '../src/renderer/ai/doc-writer'

const editors: Editor[] = []
afterEach(() => {
  for (const e of editors.splice(0)) e.destroy()
})
beforeEach(() => applyAiPanelPrefs({ aiEditUndoHistory: false }))

function createEditor(md = ''): Editor {
  const editor = new Editor({
    extensions: buildExtensions({
      slashController: { onOpen() {}, onUpdate() {}, onKeyDown: () => false, onClose() {} },
      slashItems: () => [],
    }),
    content: '',
  })
  // seeded outside history so the undo depth counts only the edits under test
  if (md) {
    editor.chain().setMeta('addToHistory', false).setContent(md, { contentType: 'markdown' }).run()
  }
  editors.push(editor)
  return editor
}

const texts = (editor: Editor) => {
  const out: string[] = []
  editor.state.doc.forEach((n) => out.push(n.textContent))
  return out
}

const insert = { op: 'insertContent', after: 'end', markdown: 'added' } as const

describe('AI edit undo history setting (markdown)', () => {
  it('keeps no undo entry for an AI op batch while the setting is off', () => {
    const editor = createEditor('one')
    const depth = undoDepth(editor.state)
    const r = runOps(editor, [insert], { source: 'ai' })
    expect(r.applied).toBe(1)
    expect(texts(editor)).toContain('added')
    expect(undoDepth(editor.state)).toBe(depth)
  })

  it('keeps one undo step for an AI op batch while the setting is on', () => {
    applyAiPanelPrefs({ aiEditUndoHistory: true })
    const editor = createEditor('one')
    const depth = undoDepth(editor.state)
    runOps(editor, [insert], { source: 'ai' })
    expect(undoDepth(editor.state)).toBe(depth + 1)
    expect(editor.commands.undo()).toBe(true)
    expect(texts(editor)).not.toContain('added')
  })

  it("keeps the person's own edits undoable whatever the setting says", () => {
    const editor = createEditor('one')
    const depth = undoDepth(editor.state)
    expect(uiOp(editor, insert)).toBe(true)
    expect(undoDepth(editor.state)).toBe(depth + 1)
  })

  it('does not drop the history beneath: undo after an AI edit still reverts the earlier human edit', () => {
    const editor = createEditor('one')
    uiOp(editor, { op: 'insertContent', after: 'end', markdown: 'human' })
    const depth = undoDepth(editor.state)
    runOps(editor, [insert], { source: 'ai' })
    expect(undoDepth(editor.state)).toBe(depth)
    expect(editor.commands.undo()).toBe(true)
    expect(texts(editor)).not.toContain('human')
  })

  it('lands a write_document stream without an undo entry while the setting is off', async () => {
    const editor = createEditor()
    const depth = undoDepth(editor.state)
    const writer: AiDocWriter = {
      write: async (_spec, onProgress) => {
        onProgress('# T')
        return { ok: true, markdown: '# T\n\nbody', truncated: false }
      },
    }
    const exec = await executeTool(
      editor,
      { id: 't', name: 'write_document', input: { plan: 'p' } },
      undefined,
      undefined,
      writer,
    )
    expect(exec.mutated).toBe(true)
    expect(texts(editor)).toEqual(['T', 'body'])
    expect(undoDepth(editor.state)).toBe(depth)
  })
})

describe('AI panel rollback points', () => {
  const panel = readFileSync(resolve(process.cwd(), 'src/renderer/ai/AiPanel.tsx'), 'utf8')

  it('captures and lists them only while the setting is on', () => {
    expect(panel).toContain(
      'aiEditUndoHistoryEnabled() ? depsRef.current.getSnapshot() : undefined',
    )
    expect(panel).toContain('{undoHistoryOn && snapshots.length > 0 && (')
    expect(panel).toContain('aiEditUndoHistoryEnabled() && snapshotBefore !== undefined')
  })
})
