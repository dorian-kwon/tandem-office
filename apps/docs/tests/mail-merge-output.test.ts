import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import {
  buildBlankDocx,
  mergeFieldInstruction,
  parseDocx,
  readSections,
  saveDocx,
} from '@genoffice/docx-engine'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { blocksToPmDoc, pmDocToSavePlan, type PmNode } from '../src/renderer/editor/convert'
import { noteDocumentSwapped, type FileActionContext } from '../src/renderer/file-actions'
import { buildMailMergeFiles } from '../src/renderer/mail-merge/output'
import { substituteMergeFields } from '../src/renderer/mail-merge/template'
import * as phasedContent from '../src/renderer/phased-content'

/**
 * The merged document, end to end: a template with a merge field in it, the
 * field filled from a record, and the .docx that comes out — the values in
 * place, no «FieldName» left. genoffice#2097.
 */

const live: Editor[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const editor of live.splice(0)) editor.destroy()
})

/** a document with the given merge field at the caret, and the parsed file behind it */
async function template() {
  const bytes = await buildBlankDocx()
  const parsed = await parseDocx(bytes)
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: blocksToPmDoc(parsed.blocks, readSections(parsed)) as never,
  })
  live.push(editor)
  editor.commands.insertContent({
    type: 'text',
    text: '«FirstName»',
    marks: [{ type: 'instrField', attrs: { instr: mergeFieldInstruction('FirstName') } }],
  })
  return { parsed, editor }
}

/** the text of a document, as the reader sees it */
async function textOf(bytes: Uint8Array): Promise<string> {
  const parsed = await parseDocx(bytes)
  return parsed.blocks.map((block) => (block.runs ?? []).map((run) => run.text).join('')).join('\n')
}

/** the field code the document carries, if any */
async function instructionsOf(bytes: Uint8Array): Promise<string[]> {
  const parsed = await parseDocx(bytes)
  return parsed.blocks
    .flatMap((block) => block.runs ?? [])
    .map((run) => run.instrField)
    .filter((instr): instr is string => typeof instr === 'string')
}

describe('the merged document', () => {
  it.each(['perRecord', 'single'] as const)(
    'includes the streamed tail in %s output',
    async (mode) => {
      const { parsed, editor } = await template()
      const ctx = {
        editor,
        doc: { parsed, fileName: 'template.docx' },
        inkAnnotations: [],
        sections: readSections(parsed),
        sectionsDirty: [],
        pgNumDirtySections: [],
        sectionHfEdits: {},
        hfLinks: {},
        styleUpserts: {},
      } as unknown as FileActionContext
      let settle!: () => void
      vi.spyOn(phasedContent, 'waitForFullContent').mockReturnValue(
        new Promise<boolean>((resolve) => (settle = () => resolve(true))),
      )
      const output = buildMailMergeFiles(ctx, {
        mode,
        records: [{ FirstName: 'Ada' }],
        fields: ['FirstName'],
        namePattern: '',
      })
      editor.commands.insertContentAt(editor.state.doc.content.size, {
        type: 'docParagraph',
        content: [{ type: 'text', text: 'Final clause' }],
      })
      settle()
      const files = await output
      expect(files).toHaveLength(1)
      expect(await textOf(files[0]!.bytes)).toMatch(/Ada[\s\S]*Final clause/)
    },
  )

  it('cancels when the document changes while the template is loading', async () => {
    const { editor } = await template()
    const snapshot = vi.spyOn(editor, 'getJSON')
    let settle!: () => void
    vi.spyOn(phasedContent, 'waitForFullContent').mockReturnValue(
      new Promise<boolean>((resolve) => (settle = () => resolve(true))),
    )
    const output = buildMailMergeFiles({ editor } as FileActionContext, {
      mode: 'perRecord',
      records: [{ FirstName: 'Ada' }],
      fields: ['FirstName'],
      namePattern: '',
    })
    noteDocumentSwapped()
    settle()
    expect(await output).toEqual([])
    expect(snapshot).not.toHaveBeenCalled()
  })

  it('keeps the merge field in the template it was built from', async () => {
    const { parsed, editor } = await template()
    const plan = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
    const saved = await saveDocx(parsed, plan.saveBlocks, {})
    expect(await textOf(saved)).toContain('«FirstName»')
    // a real field, not a placeholder: Word opens it as a merge field
    expect((await instructionsOf(saved)).join(' ')).toContain('MERGEFIELD "FirstName"')
  })

  it('writes the record value and no field code', async () => {
    const { parsed, editor } = await template()
    const merged = substituteMergeFields(editor.getJSON() as PmNode, { FirstName: 'Ada' })
    const plan = pmDocToSavePlan(merged, parsed.blocks)
    const saved = await saveDocx(parsed, plan.saveBlocks, {})
    const text = await textOf(saved)
    expect(text).toContain('Ada')
    expect(text).not.toContain('«')
    expect(await instructionsOf(saved)).toEqual([])
  })
})
