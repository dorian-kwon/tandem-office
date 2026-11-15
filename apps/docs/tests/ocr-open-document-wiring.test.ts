import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The window's side of putting OCR text into the open document. The behavior is tested in
 * ocr-open-document.test.ts; this keeps the wires that connect it from coming loose: the chat tool
 * gets the editor's hook, and every way of undoing or redoing asks the OCR text first.
 */

const read = (rel: string) => readFileSync(join(__dirname, '../src/renderer', rel), 'utf8')
const app = read('App.tsx')
const panel = read('ai/AiPanel.tsx')

describe('the chat tool reaches the editor', () => {
  it('App gives the AI panel the hook, built from the live context', () => {
    expect(app).toContain('placeOcrIntoOpenDocument(fileCtxRef.current')
    expect(app).toContain('ocrIntoDocumentUnavailableReason(fileCtxRef.current')
    expect(app).toMatch(/<AiPanel[\s\S]*?ocrOpenDocument=\{ocrOpenDocument\}/)
  })

  it('the panel hands it to the project skill, so apply can ask for the open document', () => {
    expect(panel).toMatch(/panelProjectSkill\(\{[^}]*openDocument: ocrOpenDocument/s)
  })
})

describe('undo and redo ask the OCR text first', () => {
  it('the menu, the ribbon buttons and the shortcut keys all do', () => {
    // menu and shortcut command ids
    expect(app).toMatch(
      /case 'undo':\s*(?:\/\/[^\n]*\s*)?if \(editor && tryOcrUndo\(fileCtxRef\.current\)\) break/,
    )
    expect(app).toMatch(
      /case 'redo':\s*(?:\/\/[^\n]*\s*)?if \(editor && tryOcrRedo\(fileCtxRef\.current\)\) break/,
    )
    // the quick-access buttons
    expect(app).toMatch(
      /onClick=\{\(\) => \{\s*if \(editor && tryOcrUndo\(fileCtxRef\.current\)\) return/,
    )
    expect(app).toMatch(
      /onClick=\{\(\) => \{\s*if \(editor && tryOcrRedo\(fileCtxRef\.current\)\) return/,
    )
    // the keys go through the extension, which asks what the window registered
    expect(app).toContain('registerOcrHistoryHandlers(')
  })

  it('the buttons stay on while the OCR text can still be undone or redone', () => {
    expect(app).toMatch(/canUndo: editor\.can\(\)\.undo\(\) \|\| ocrUndoAvailable\(editor\)/)
    expect(app).toMatch(/canRedo: editor\.can\(\)\.redo\(\) \|\| ocrRedoAvailable\(editor\)/)
  })
})

describe('the automation hook', () => {
  it('can place, undo and redo OCR text without the AI, for end-to-end checks', () => {
    for (const name of ['ocrReason', 'placeOcr', 'ocrUndo', 'ocrRedo', 'isUnsaved'])
      expect(app).toContain(`${name}:`)
  })
})
