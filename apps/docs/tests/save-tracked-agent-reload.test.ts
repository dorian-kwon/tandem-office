import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { Editor } from '@tiptap/core'
import { parseDocx, readSections } from '@genoffice/docx-engine'
import { buildDocx, TABLE_XML } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { blocksToPmDoc, pmDocOptions } from '../src/renderer/editor/convert'
import { collectRevisions } from '../src/renderer/editor/revisions'
import { executeTool } from '../src/renderer/ai/tools'
import { noteDocumentSwapped, save, type FileActionContext } from '../src/renderer/file-actions'
import { EMPTY_HF_VARIANTS } from '../src/renderer/doc-state'
import * as savedReload from '../src/renderer/save-reload'
import type { AiNotesAccess } from '../src/renderer/ai/note-ops'
import { createTranslationUnitIndex } from '../src/renderer/ai/translation-units'

;(globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s }

const dirs: string[] = []
const editors: Editor[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const editor of editors.splice(0)) editor.destroy()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const paragraph = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`
const first = paragraph('Unchanged opening paragraph.')
const last = paragraph('Unchanged closing paragraph.')
const bodyXml = first + TABLE_XML + paragraph('Respond within forty-eight (48) hours.') + last

async function fixture(tracking: boolean, withNotes = false) {
  noteDocumentSwapped()
  const bytes = await buildDocx({
    bodyXml: withNotes
      ? bodyXml +
        '<w:p><w:r><w:t>Note anchor.</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>'
      : bodyXml,
    ...(withNotes
      ? {
          extraRels:
            '<Relationship Id="rIdNotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>',
          extraParts: [
            {
              path: 'word/footnotes.xml',
              contentType:
                'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml',
              xml: '<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="1"><w:p><w:r><w:t>Pending note source.</w:t></w:r></w:p></w:footnote></w:footnotes>',
            },
          ],
        }
      : {}),
  })
  const parsed = await parseDocx(bytes)
  const dir = await mkdtemp(join(tmpdir(), 'genoffice-save-tracked-'))
  dirs.push(dir)
  const path = join(dir, 'fixture.docx')
  await writeFile(path, bytes)
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    editorProps: { handleScrollToSelection: () => true },
    content: blocksToPmDoc(parsed.blocks, readSections(parsed), pmDocOptions(parsed)),
  })
  editors.push(editor)
  editor.storage.trackChanges.enabled = tracking
  const state = {
    editor,
    doc: { parsed, filePath: path, fileName: 'fixture.docx', hash: 'fixture' },
    footnotes: parsed.footnotes,
    endnotes: parsed.endnotes,
    dirtyRef: { current: false },
    saveInFlightRef: { current: false },
    saveIncompleteRef: { current: false },
    inkAnnotations: [],
    sections: readSections(parsed),
    sectionsDirty: [],
    pgNumDirtySections: [],
    hfVariants: EMPTY_HF_VARIANTS,
    hfVariantsDirty: [],
    sectionHfEdits: {},
    hfLinks: {},
    styleUpserts: {},
    pendingNumbering: { newDefs: [], restartNums: [] },
  }
  const noop = () => {}
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop === 'setFootnotes')
        return (value: typeof state.footnotes) => {
          target.footnotes = value
        }
      if (prop === 'setEndnotes')
        return (value: typeof state.endnotes) => {
          target.endnotes = value
        }
      if (prop === 'setDoc')
        return (updater: (prev: typeof state.doc) => typeof state.doc) => {
          target.doc = updater(target.doc)
        }
      if (prop in target) return Reflect.get(target, prop)
      if (typeof prop === 'string' && (/^set[A-Z]/.test(prop) || /^on[A-Z]/.test(prop))) return noop
      return undefined
    },
  }) as unknown as FileActionContext
  window.desktop = {
    saveDocx: async (target: string, data: ArrayBuffer) => {
      await writeFile(target, new Uint8Array(data))
      return { ok: true }
    },
  } as unknown as typeof window.desktop
  return { editor, ctx, path, bytes }
}

async function replace(editor: Editor) {
  const result = await executeTool(
    editor,
    {
      id: 'fixture-edit',
      name: 'apply_ops',
      input: {
        ops: [
          { op: 'findReplace', find: 'forty-eight (48) hours', replace: 'seventy-two (72) hours' },
        ],
      },
    },
    { bullet: null, ordered: null },
    { author: 'Fixture Agent' },
  )
  expect(result.isError).toBeFalsy()
}

async function assertUntouched(original: Uint8Array, saved: Uint8Array) {
  const before = await JSZip.loadAsync(original)
  const after = await JSZip.loadAsync(saved)
  const xml = await after.file('word/document.xml')!.async('string')
  expect(xml).toContain(first)
  expect(xml).toContain(last)
  expect(xml).toContain(TABLE_XML)
  for (const [name, part] of Object.entries(before.files)) {
    if (part.dir || name === 'word/document.xml') continue
    expect(await after.file(name)!.async('uint8array'), name).toEqual(
      await part.async('uint8array'),
    )
  }
}

describe('production save reload with track changes enabled', () => {
  it.each([false, true])(
    'keeps the live model aligned after an agent edit (auto=%s)',
    async (auto) => {
      const { editor, ctx, path, bytes } = await fixture(true)
      await replace(editor)
      expect(editor.state.doc.childCount).toBe(4)
      expect(collectRevisions(editor.state.doc)).toHaveLength(2)
      for (let pass = 0; pass < 2; pass++) {
        expect(await save(ctx, false, auto)).toBe(true)
        const disk = await readFile(path)
        const parsed = await parseDocx(disk)
        expect(
          parsed.blocks.filter((block) => block.type !== 'passthrough'),
          `disk save ${pass + 1}`,
        ).toHaveLength(4)
        expect(editor.state.doc.childCount, `live save ${pass + 1}`).toBe(4)
        expect(collectRevisions(editor.state.doc)).toHaveLength(2)
        expect(editor.storage.trackChanges.enabled).toBe(true)
        await assertUntouched(bytes, disk)
      }
    },
  )

  it('keeps tracking-off edits clean through the same production save', async () => {
    const { editor, ctx, path, bytes } = await fixture(false)
    // No AI tracking override: this control follows the currently disabled recorder.
    const result = await executeTool(
      editor,
      {
        id: 'off-edit',
        name: 'apply_ops',
        input: {
          ops: [
            {
              op: 'findReplace',
              find: 'forty-eight (48) hours',
              replace: 'seventy-two (72) hours',
            },
          ],
        },
      },
      { bullet: null, ordered: null },
    )
    expect(result.isError).toBeFalsy()
    expect(await save(ctx, false, true)).toBe(true)
    expect(editor.state.doc.childCount).toBe(4)
    expect(collectRevisions(editor.state.doc)).toHaveLength(0)
    await assertUntouched(bytes, await readFile(path))
  })

  it('keeps a manually typed tracked insertion through production save', async () => {
    const { editor, ctx } = await fixture(true)
    editor.view.dispatch(editor.state.tr.insertText('Typed ', 1))
    const count = editor.state.doc.childCount
    const revisions = collectRevisions(editor.state.doc).length
    expect(revisions).toBe(1)
    expect(await save(ctx, false, true)).toBe(true)
    expect(editor.state.doc.childCount).toBe(count)
    expect(collectRevisions(editor.state.doc)).toHaveLength(revisions)
  })

  it('keeps an untouched document clean while tracking is enabled', async () => {
    const { editor, ctx } = await fixture(true)
    expect(await save(ctx, false, true)).toBe(true)
    expect(editor.state.doc.childCount).toBe(4)
    expect(collectRevisions(editor.state.doc)).toHaveLength(0)
  })

  it('keeps pending translation provenance through the production save fallback', async () => {
    const { editor, ctx } = await fixture(false, true)
    const notes: AiNotesAccess = {
      list: (kind) => (kind === 'footnote' ? ctx.footnotes : ctx.endnotes),
      add: () => '',
      remove: () => false,
      replace: () => false,
    }
    const originalNotes = ctx.footnotes
    expect(originalNotes).toHaveLength(1)
    const index = createTranslationUnitIndex(editor, () => notes)
    const pending = index.snapshot(undefined, true)
    expect(pending[0].segments).toEqual(['Unchanged opening paragraph.'])
    // The shape-normalizing save branch is covered by the 70-unit regression;
    // force it here to exercise the production writer/reparse/dispatch seam.
    vi.spyOn(savedReload, 'applyAnchorOnlyReload').mockReturnValue(null)
    expect(await save(ctx, false, true)).toBe(true)
    expect(ctx.footnotes).not.toBe(originalNotes)
    expect(pending.some((unit) => unit.segments.includes('Pending note source.'))).toBe(true)
    expect(pending.every((unit) => index.resolve(unit) !== null)).toBe(true)
    expect(index.resolve(pending[0])?.segments).toEqual(['Unchanged opening paragraph.'])
    index.dispose()
  })
})
