import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { undoDepth } from '@tiptap/pm/history'
import { applyAiPanelPrefs } from '@genoffice/ui'
import { buildExtensions } from '../src/renderer/editor/extensions'
import { runOps, uiOp } from '../src/renderer/editor/ops'
import { executeTool } from '../src/renderer/ai/tools'
import { SnapshotBody } from '../src/renderer/ai/snapshot-body'
import { buildSourceMap } from '../src/renderer/markdown/sourceSplice'
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
  it('retains earlier blocks when later translation batches cross native history depth', () => {
    applyAiPanelPrefs({ aiEditUndoHistory: true })
    const editor = createEditor(Array.from({ length: 160 }, () => 'source').join('\n\n'))
    for (let start = 0; start < 160; start += 40) {
      const result = runOps(
        editor,
        Array.from({ length: 40 }, (_, i) => ({
          op: 'replaceText',
          target: { start: start + i },
          find: 'source',
          replace: '번역',
        })),
        { source: 'ai', translation: true },
      )
      expect(result.applied).toBe(40)
    }
    expect(undoDepth(editor.state)).toBe(160)
    for (let i = 0; i < 160; i++) expect(editor.commands.undo()).toBe(true)
    expect(texts(editor)).toEqual(Array(160).fill('source'))
  })

  it.each([true, false])(
    'records each changed translated block of one tool call (history %s)',
    async (enabled) => {
      applyAiPanelPrefs({ aiEditUndoHistory: enabled })
      const editor = createEditor('one\n\ntwo\n\nthree')
      const before = editor.state.doc.toJSON()
      const result = await executeTool(editor, {
        id: 'translation',
        name: 'apply_ops',
        input: {
          intent: 'translation',
          ops: [
            { op: 'replaceText', target: { start: 2 }, find: 'three', replace: '셋' },
            { op: 'replaceText', target: { start: 1 }, find: 'two', replace: 'two' },
            { op: 'replaceBlocks', target: { start: 0 }, markdown: '**하나**' },
          ],
        },
      })
      expect(result.isError).toBeFalsy()
      const translated = editor.state.doc.toJSON()
      expect(texts(editor)).toEqual(['하나', 'two', '셋'])
      editor.view.dispatch(editor.state.tr.insertText('!', editor.state.doc.content.size - 1))
      expect(editor.commands.undo()).toBe(true)
      expect(editor.state.doc.toJSON()).toEqual(translated)
      expect(undoDepth(editor.state)).toBe(enabled ? 2 : 0)
      if (!enabled) return
      expect(editor.commands.undo()).toBe(true)
      expect(texts(editor)).toEqual(['one', 'two', '셋'])
      expect(editor.commands.undo()).toBe(true)
      expect(editor.state.doc.toJSON()).toEqual(before)
      expect(editor.commands.redo()).toBe(true)
      expect(editor.commands.redo()).toBe(true)
      expect(editor.state.doc.toJSON()).toEqual(translated)
    },
  )

  it.each([false, true])(
    'separates a multi-block AI call from adjacent typing (history %s)',
    (enabled) => {
      applyAiPanelPrefs({ aiEditUndoHistory: enabled })
      const editor = createEditor('one\n\ntwo\n\nthree')
      editor.view.dispatch(editor.state.tr.insertText('H', 1))
      const r = runOps(
        editor,
        [
          { op: 'replaceText', target: { start: 0 }, find: 'one', replace: '1' },
          { op: 'replaceText', target: { start: 2 }, find: 'three', replace: '3' },
        ],
        { source: 'ai' },
      )
      expect(r.applied).toBe(2)
      editor.view.dispatch(editor.state.tr.insertText('M', editor.state.doc.content.size - 1))
      expect(editor.commands.undo()).toBe(true)
      expect(texts(editor)).toEqual(['H1', 'two', '3'])
      if (enabled) {
        expect(editor.commands.undo()).toBe(true)
        expect(texts(editor)).toEqual(['Hone', 'two', 'three'])
      }
      expect(editor.commands.undo()).toBe(true)
      expect(texts(editor)).toEqual(enabled ? ['one', 'two', 'three'] : ['1', 'two', '3'])
      expect(editor.commands.redo()).toBe(true)
      if (enabled) expect(editor.commands.redo()).toBe(true)
      expect(editor.commands.redo()).toBe(true)
      expect(texts(editor)).toEqual(['H1', 'two', '3M'])
    },
  )

  it.each([false, true])(
    'records YAML with the body and restores the original fenced bytes (history %s)',
    (enabled) => {
      applyAiPanelPrefs({ aiEditUndoHistory: enabled })
      const editor = createEditor('one')
      const original = '---\ntitle: Original\n---\n\n\n'
      let raw = original
      const fm = {
        read: () => raw,
        write: (v: string) => {
          raw = v
        },
      }
      const r = runOps(
        editor,
        [
          { op: 'setFrontmatter', yaml: 'title: Revised' },
          { op: 'replaceText', target: { start: 0 }, find: 'one', replace: 'two' },
        ],
        { source: 'ai', frontmatter: fm },
      )
      expect(r.applied).toBe(2)
      expect(editor.can().undo()).toBe(enabled)
      expect(raw).toBe('---\ntitle: Revised\n---\n\n')
      expect(texts(editor)).toEqual(['two'])
      if (enabled) {
        expect(editor.commands.undo()).toBe(true)
        expect(raw).toBe(original)
        expect(texts(editor)).toEqual(['one'])
        expect(editor.commands.redo()).toBe(true)
        expect(raw).toBe('---\ntitle: Revised\n---\n\n')
        expect(texts(editor)).toEqual(['two'])
      }
    },
  )

  it('undoes just the successful prefix when a later op is refused', () => {
    applyAiPanelPrefs({ aiEditUndoHistory: true })
    const editor = createEditor('one')
    const result = runOps(
      editor,
      [
        { op: 'insertContent', after: 0, markdown: 'accepted' },
        { op: 'deleteBlocks', target: { start: 99 } },
      ],
      { source: 'ai' },
    )
    expect(result.applied).toBe(1)
    expect(editor.commands.undo()).toBe(true)
    expect(texts(editor)).toEqual(['one'])
    expect(editor.commands.undo()).toBe(false)
    expect(editor.commands.redo()).toBe(true)
    expect(texts(editor)).toEqual(['one', 'accepted'])
  })

  it('does not offer a panel checkpoint when applying the existing YAML', async () => {
    applyAiPanelPrefs({ aiEditUndoHistory: true })
    const editor = createEditor('one')
    const fm = { read: () => '---\ntitle: Old\n---\n\n', write: () => {} }
    const result = await executeTool(
      editor,
      {
        id: 't',
        name: 'apply_ops',
        input: { ops: [{ op: 'setFrontmatter', yaml: 'title: Old' }] },
      },
      undefined,
      fm,
    )
    expect(result.isError).toBeFalsy()
    expect(result.mutated).toBe(false)
    expect(undoDepth(editor.state)).toBe(0)
  })

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

  it('serializes a document body once until an edit or replacement of the source map', () => {
    const editor = createEditor('original')
    const cache = new SnapshotBody()
    const serialize = vi.fn(() => editor.getMarkdown())
    const doc = editor.state.doc
    expect(cache.read(doc, null, serialize)).toBe('original')
    expect(cache.read(doc, null, serialize)).toBe('original')
    const sourceMap = buildSourceMap(editor, doc, 'original')
    expect(sourceMap).not.toBeNull()
    expect(cache.read(doc, sourceMap, serialize)).toBe('original')
    editor.view.dispatch(editor.state.tr.insertText('!', 1))
    expect(cache.read(editor.state.doc, sourceMap, serialize)).toContain('!')
    expect(serialize).toHaveBeenCalledTimes(3)
  })

  it('captures and lists them only while the setting is on', () => {
    expect(panel).toContain(
      'if (!aiEditUndoHistoryEnabled() || depsRef.current.getSource?.()) return undefined',
    )
    expect(panel).toContain('{undoHistoryOn && snapshots.length > 0 && (')
    expect(panel).toContain('aiEditUndoHistoryEnabled() && snapshotBefore !== undefined')
  })
})
