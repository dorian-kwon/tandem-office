import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { applyAiPanelPrefs } from '@genoffice/ui'
import JSZip from 'jszip'
import { parseDocx, saveDocx } from '@genoffice/docx-engine'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { blocksToPmDoc, pmDocToSavePlan, type PmNode } from '../src/renderer/editor/convert'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { readRunGroups } from '../src/renderer/ai/translate-runs'
import type { DocState } from '../src/renderer/doc-state'
import type { FileActionContext } from '../src/renderer/file-actions'
import {
  clearOcrHistory,
  ocrIntoDocumentAvailable,
  ocrIntoDocumentUnavailableReason,
  ocrRedoAvailable,
  ocrUndoAvailable,
  placeOcrIntoOpenDocument,
  tryOcrRedo,
  tryOcrUndo,
} from '../src/renderer/ocr-open-document'

/**
 * OCR text into the Word document on screen. The document keeps its file, becomes unsaved, and
 * what was on screen before can be brought back with undo and forward again with redo.
 */

const picture = (id: string) =>
  '<w:r><w:drawing><wp:inline><wp:extent cx="3000000" cy="1500000"/><wp:docPr id="7" name="P"/>' +
  '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
  `<pic:pic><pic:blipFill><a:blip r:embed="${id}"/></pic:blipFill></pic:pic></a:graphicData>` +
  '</a:graphic></wp:inline></w:drawing></w:r>'
const BOXES = [
  { x: 0.1, y: 0.2, w: 0.3, h: 0.1, fontHeight: 0.08, text: 'Shop name' },
  { x: 0.5, y: 0.6, w: 0.3, h: 0.1, fontHeight: 0.08, text: 'Opening hours' },
]
const plan = (relId = 'rId10') => ({
  format: 'docx' as const,
  items: [
    {
      index: 1,
      text: 'Shop name\nOpening hours',
      location: 'document.xml · ¶2',
      part: 'word/document.xml',
      relId,
    },
  ],
  placement: { kind: 'docx-image-boxes', images: [{ index: 1, boxes: BOXES }] },
})

type Parsed = Awaited<ReturnType<typeof parseDocx>>
const live: Editor[] = []
let ctx: FileActionContext
let editor: Editor
let original: Parsed

/** the parts of the editor's context the module reads; everything else is the quiet default */
function makeCtx(target: Record<string, unknown>): FileActionContext {
  const arrays = [
    'sectionsDirty',
    'pgNumDirtySections',
    'hfVariantsDirty',
    'inkAnnotations',
    'sections',
  ]
  const objects = ['sectionHfEdits', 'styleUpserts', 'hfLinks']
  return new Proxy(target, {
    get(t, key: string) {
      if (key in t) return t[key]
      if (key.startsWith('set')) return () => undefined
      if (key.endsWith('Dirty')) return false
      if (arrays.includes(key)) return []
      if (objects.includes(key)) return {}
      return undefined
    },
  }) as unknown as FileActionContext
}

async function open(extra: Partial<DocState> = {}) {
  const source = await buildDocx({
    withImage: true,
    bodyXml:
      '<w:p><w:r><w:t>Intro</w:t></w:r></w:p>' +
      '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="6000"/></w:tblGrid><w:tr><w:tc>' +
      `<w:p>${picture('rId10')}</w:p></w:tc></w:tr></w:tbl><w:p/>`,
  })
  original = await parseDocx(source)
  editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: blocksToPmDoc(original.blocks) as never,
  })
  live.push(editor)
  const state: Record<string, unknown> = {
    editor,
    dirtyRef: { current: false },
    doc: {
      parsed: original,
      filePath: '/work/book.docx',
      fileName: 'book.docx',
      hash: 'h',
      format: 'docx',
      ...extra,
    },
  }
  state.setDoc = (update: (prev: DocState | null) => DocState | null) => {
    state.doc = update(state.doc as DocState)
  }
  ctx = makeCtx(state)
}

const deps = {
  buildBytes: async (c: FileActionContext) =>
    saveDocx(
      c.doc!.parsed,
      pmDocToSavePlan(c.editor!.getJSON() as PmNode, c.doc!.parsed.blocks).saveBlocks,
    ),
  parse: parseDocx,
}
const place = (p = plan()) => placeOcrIntoOpenDocument(ctx, p, deps)
const boxTexts = () =>
  readRunGroups(editor, 0, editor.state.doc.childCount - 1)
    .filter((e) => e.box !== undefined)
    .map((e) => e.segments?.[0])
/** an edit the way the app sees it: the editor changes and the document is marked unsaved */
const unsavedEdit = () => {
  editor.chain().focus('start').insertContent('EDITED ').run()
  ctx.dirtyRef.current = true
}

beforeEach(() => {
  // the editor window has CSS.escape; the test environment does not
  vi.stubGlobal('CSS', { escape: (value: string) => value })
  clearOcrHistory()
  // undo of the OCR text exists only while "AI edit undo history" is on (decision 0114)
  applyAiPanelPrefs({ aiEditUndoHistory: true })
})
afterEach(() => {
  live.splice(0).forEach((e) => e.destroy())
  vi.unstubAllGlobals()
  applyAiPanelPrefs({ aiEditUndoHistory: false })
})

describe('putting OCR text into the document on screen', () => {
  it('adds the boxes, keeps an unsaved edit and the file, and leaves the document unsaved', async () => {
    await open()
    unsavedEdit()
    const result = await place()
    expect(result).toEqual({ ok: true, placed: [1], skipped: [] })
    expect(editor.state.doc.textContent).toContain('EDITED Intro')
    expect(boxTexts()).toEqual(['Shop name', 'Opening hours'])
    expect(ctx.dirtyRef.current).toBe(true)
    expect(ctx.doc!.filePath).toBe('/work/book.docx')
    expect(ctx.doc!.fileName).toBe('book.docx')
    expect(ctx.doc!.parsed).not.toBe(original)
  })

  it('saves the edit, the boxes and the picture together when the person saves', async () => {
    await open()
    unsavedEdit()
    await place()
    const saved = await deps.buildBytes(ctx)
    const xml = await (await JSZip.loadAsync(saved)).file('word/document.xml')!.async('string')
    expect(xml).toContain('EDITED Intro')
    expect(xml).toContain('Shop name')
    expect(xml).toContain('r:embed="rId10"')
  })

  it('reports a picture that is no longer there and places the others', async () => {
    await open()
    const two = {
      ...plan(),
      items: [...plan().items, { ...plan().items[0]!, index: 2, relId: 'rIdGone' }],
      placement: {
        kind: 'docx-image-boxes',
        images: [
          { index: 1, boxes: BOXES },
          { index: 2, boxes: BOXES },
        ],
      },
    }
    expect(await place(two)).toEqual({ ok: true, placed: [1], skipped: [2] })
  })

  it('leaves the document alone when none of the pictures is left', async () => {
    await open()
    const before = editor.getJSON()
    const result = await place(plan('rIdGone'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/picture/i)
    expect(editor.getJSON()).toEqual(before)
    expect(ctx.dirtyRef.current).toBe(false)
    expect(ocrUndoAvailable(editor)).toBe(false)
  })
})

describe('when the document on screen cannot take it', () => {
  it.each([
    ['an ODT document', { format: 'odt' as const }],
    ['an encrypted document', { encrypted: true }],
  ])('refuses %s without touching it', async (_name, extra) => {
    await open(extra as Partial<DocState>)
    expect(ocrIntoDocumentAvailable(ctx)).toBe(false)
    const before = editor.getJSON()
    const result = await place()
    expect(result.ok).toBe(false)
    expect(editor.getJSON()).toEqual(before)
  })

  it('refuses a read-only document (the source copy, the translation lock)', async () => {
    await open()
    editor.setEditable(false)
    expect(ocrIntoDocumentAvailable(ctx)).toBe(false)
    expect((await place()).ok).toBe(false)
  })

  it('refuses while there are other unsaved changes the bytes would carry along', async () => {
    await open()
    ;(ctx as unknown as Record<string, unknown>).headerDirty = true
    expect(ocrIntoDocumentAvailable(ctx)).toBe(false)
    expect((await place()).ok).toBe(false)
  })

  it('takes a document that is only edited in the body', async () => {
    await open()
    unsavedEdit()
    expect(ocrIntoDocumentAvailable(ctx)).toBe(true)
  })
})

describe('why the document on screen cannot take it', () => {
  it('says nothing is wrong for a body-only edited Word document', async () => {
    await open()
    unsavedEdit()
    expect(ocrIntoDocumentUnavailableReason(ctx)).toBeNull()
  })

  it.each([
    ['an ODT document', { format: 'odt' as const }, /odt|docx/i],
    ['an encrypted document', { encrypted: true }, /password|encrypt/i],
  ])('names %s', async (_name, extra, expected) => {
    await open(extra as Partial<DocState>)
    expect(ocrIntoDocumentUnavailableReason(ctx)).toMatch(expected)
  })

  it('names a read-only document', async () => {
    await open()
    editor.setEditable(false)
    expect(ocrIntoDocumentUnavailableReason(ctx)).toMatch(/read-only/i)
  })

  it('names which other unsaved changes there are', async () => {
    await open()
    const target = ctx as unknown as Record<string, unknown>
    target.headerDirty = true
    target.commentsDirty = true
    const reason = ocrIntoDocumentUnavailableReason(ctx)!
    expect(reason).toMatch(/header/i)
    expect(reason).toMatch(/comments/i)
  })

  it('agrees with the yes or no answer', async () => {
    await open()
    expect(ocrIntoDocumentAvailable(ctx)).toBe(true)
    editor.setEditable(false)
    expect(ocrIntoDocumentAvailable(ctx)).toBe(false)
  })
})

describe('a translation that is running locks the output, and OCR text still goes in', () => {
  it('does not take the lock for a reason: the lock holds off the person, not the AI’s own write', async () => {
    await open()
    editor.setEditable(false)
    expect(ocrIntoDocumentUnavailableReason(ctx, { translationLocked: true })).toBeNull()
    // without the lock the same editor is read-only for real
    expect(ocrIntoDocumentUnavailableReason(ctx)).toMatch(/read-only/i)
  })

  it('puts the text in while the editor is locked, and the document is unsaved', async () => {
    await open()
    unsavedEdit()
    editor.setEditable(false)
    const result = await placeOcrIntoOpenDocument(ctx, plan(), deps, { translationLocked: true })
    expect(result).toEqual({ ok: true, placed: [1], skipped: [] })
    expect(boxTexts()).toEqual(['Shop name', 'Opening hours'])
    expect(editor.state.doc.textContent).toContain('EDITED Intro')
    expect(ctx.dirtyRef.current).toBe(true)
  })

  it('leaves the editor as locked as it found it, for the translation to release', async () => {
    await open()
    editor.setEditable(false)
    await placeOcrIntoOpenDocument(ctx, plan(), deps, { translationLocked: true })
    expect(editor.isEditable).toBe(false)
  })

  it('undo works afterwards, once the editor is editable again', async () => {
    await open()
    editor.setEditable(false)
    await placeOcrIntoOpenDocument(ctx, plan(), deps, { translationLocked: true })
    editor.setEditable(true)
    expect(ocrUndoAvailable(editor)).toBe(true)
    expect(tryOcrUndo(ctx)).toBe(true)
    expect(boxTexts()).toEqual([])
  })

  it('still refuses a read-only document when the lock is not the reason (Read Mode, protection)', async () => {
    await open()
    editor.setEditable(false)
    const result = await placeOcrIntoOpenDocument(ctx, plan(), deps, { translationLocked: false })
    expect(result.ok).toBe(false)
    expect(boxTexts()).toEqual([])
  })
})

describe('undo and redo of the OCR text', () => {
  it('Ctrl+Z brings back what was on screen, unsaved edit included, and the saved state', async () => {
    await open()
    unsavedEdit()
    await place()
    expect(ocrUndoAvailable(editor)).toBe(true)

    expect(tryOcrUndo(ctx)).toBe(true)

    expect(boxTexts()).toEqual([])
    expect(editor.state.doc.textContent).toContain('EDITED Intro')
    expect(ctx.doc!.parsed).toBe(original)
    expect(ctx.doc!.filePath).toBe('/work/book.docx')
    // it was unsaved before the OCR too
    expect(ctx.dirtyRef.current).toBe(true)
    expect(ocrUndoAvailable(editor)).toBe(false)
  })

  it('brings back a document that was saved before the OCR as saved', async () => {
    await open()
    await place()
    tryOcrUndo(ctx)
    expect(ctx.dirtyRef.current).toBe(false)
  })

  it('Ctrl+Shift+Z puts the OCR text back', async () => {
    await open()
    await place()
    tryOcrUndo(ctx)
    expect(ocrRedoAvailable(editor)).toBe(true)

    expect(tryOcrRedo(ctx)).toBe(true)

    expect(boxTexts()).toEqual(['Shop name', 'Opening hours'])
    expect(ctx.dirtyRef.current).toBe(true)
    expect(ocrUndoAvailable(editor)).toBe(true)
  })

  it('undoes later edits one by one first, then the OCR text', async () => {
    await open()
    await place()
    editor.chain().focus('start').insertContent('LATER ').run()
    expect(ocrUndoAvailable(editor)).toBe(false)
    expect(tryOcrUndo(ctx)).toBe(false)
    editor.commands.undo()
    expect(editor.state.doc.textContent).not.toContain('LATER')
    expect(ocrUndoAvailable(editor)).toBe(true)
    expect(tryOcrUndo(ctx)).toBe(true)
    expect(boxTexts()).toEqual([])
  })

  it('cannot be redone after the document was edited', async () => {
    await open()
    await place()
    tryOcrUndo(ctx)
    editor.chain().focus('start').insertContent('NEW ').run()
    expect(ocrRedoAvailable(editor)).toBe(false)
    expect(tryOcrRedo(ctx)).toBe(false)
  })

  it('is gone once the document is saved or another document is opened', async () => {
    await open()
    await place()
    clearOcrHistory()
    expect(ocrUndoAvailable(editor)).toBe(false)
    expect(tryOcrUndo(ctx)).toBe(false)
  })

  it('is only for what was placed into this document', async () => {
    await open()
    expect(ocrUndoAvailable(editor)).toBe(false)
    expect(tryOcrUndo(ctx)).toBe(false)
  })
})

describe('with AI edit undo history off', () => {
  it('restores the document after a swap fails after changing its body', async () => {
    applyAiPanelPrefs({ aiEditUndoHistory: false })
    await open()
    unsavedEdit()
    const before = editor.getJSON()
    const parsed = ctx.doc!.parsed
    ctx.setDocCss = vi.fn().mockImplementationOnce(() => {
      expect(editor.getJSON()).not.toEqual(before)
      throw new Error('failed after replacing content')
    })
    const result = await place()
    expect(result).toEqual({ ok: false, reason: 'failed after replacing content' })
    expect(editor.getJSON()).toEqual(before)
    expect(ctx.doc!.parsed).toBe(parsed)
    expect(ctx.dirtyRef.current).toBe(true)
    expect(ocrUndoAvailable(editor)).toBe(false)
    expect(tryOcrUndo(ctx)).toBe(false)
  })

  it('puts the OCR text in without keeping any undo of it', async () => {
    applyAiPanelPrefs({ aiEditUndoHistory: false })
    await open()
    unsavedEdit()
    const result = await place()
    expect(result).toEqual({ ok: true, placed: [1], skipped: [] })
    expect(boxTexts()).toEqual(['Shop name', 'Opening hours'])
    expect(ctx.dirtyRef.current).toBe(true)
    expect(ocrUndoAvailable(editor)).toBe(false)
    expect(tryOcrUndo(ctx)).toBe(false)
    expect(boxTexts()).toEqual(['Shop name', 'Opening hours'])
  })

  it('forgets an earlier OCR undo, which would now return to an older document', async () => {
    await open()
    await place()
    expect(ocrUndoAvailable(editor)).toBe(true)
    applyAiPanelPrefs({ aiEditUndoHistory: false })
    await place()
    expect(ocrUndoAvailable(editor)).toBe(false)
  })
})

describe('ending the undo of the OCR text', () => {
  it('opening another document ends it', async () => {
    const { noteDocumentSwapped } = await import('../src/renderer/file-actions')
    await open()
    await place()
    expect(ocrUndoAvailable(editor)).toBe(true)
    noteDocumentSwapped()
    expect(ocrUndoAvailable(editor)).toBe(false)
  })

  it('a save ends it: the save reads like the save of any other document', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(__dirname, '../src/renderer/file-actions.ts'), 'utf8')
    const at = src.indexOf('applyReparsedState(ctx, reparsed, savedPath)')
    const forgets = src.indexOf('clearOcrHistory()', at)
    const done = src.indexOf('ctx.dirtyRef.current = false', at)
    expect(at).toBeGreaterThan(-1)
    // the saved document is the new baseline: undo may not return to a baseline from before it
    expect(forgets).toBeGreaterThan(at)
    expect(forgets).toBeLessThan(done)
  })
})

describe('Ctrl+Z and Ctrl+Shift+Z in the editor', () => {
  const press = (key: string, shift = false) =>
    editor.view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key, ctrlKey: true, shiftKey: shift, bubbles: true }),
    )

  it('reach the OCR undo and redo before the editor’s own history', async () => {
    const { registerOcrHistoryHandlers } = await import('../src/renderer/ocr-history-state')
    await open()
    const calls: string[] = []
    registerOcrHistoryHandlers({
      undo: () => (calls.push('undo'), true),
      redo: () => (calls.push('redo'), true),
    })
    press('z')
    press('z', true)
    press('y')
    expect(calls).toEqual(['undo', 'redo', 'redo'])
    registerOcrHistoryHandlers(null)
  })

  it('leave the key to the editor’s history when the OCR text has nothing to undo', async () => {
    const { registerOcrHistoryHandlers } = await import('../src/renderer/ocr-history-state')
    await open()
    registerOcrHistoryHandlers({ undo: () => false, redo: () => false })
    editor.chain().focus('start').insertContent('TYPED ').run()
    expect(editor.state.doc.textContent).toContain('TYPED')
    press('z')
    expect(editor.state.doc.textContent).not.toContain('TYPED')
    registerOcrHistoryHandlers(null)
  })
})
