import { executeOps } from '../src/renderer/ai/ops'
import { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { parseDocx, saveDocx } from '@genoffice/docx-engine'
import { describe, expect, it } from 'vitest'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { blocksToPmDoc, pmDocToSavePlan, type PmNode } from '../src/renderer/editor/convert'
import { editorExtensions } from '../src/renderer/editor/extensions'

// A real edit inside a table cell used to go through the plain-text cell patch:
// every run collapsed onto the first run's rPr and hyperlinks lost their
// w:hyperlink wrapper. The rich per-paragraph patch must keep both.
const TABLE =
  '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr>' +
  '<w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid>' +
  '<w:tr>' +
  '<w:tc><w:p><w:r><w:t xml:space="preserve">contact </w:t></w:r>' +
  '<w:hyperlink r:id="rId9"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>mail us</w:t></w:r></w:hyperlink>' +
  '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve"> now</w:t></w:r></w:p>' +
  '<w:p><w:r><w:rPr><w:i/></w:rPr><w:t>second para</w:t></w:r></w:p></w:tc>' +
  '<w:tc><w:p><w:r><w:t>other cell</w:t></w:r></w:p></w:tc>' +
  '</w:tr>' +
  '</w:tbl>'

const RELS =
  '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="mailto:team@example.com" TargetMode="External"/>'

async function openDoc() {
  const source = await buildDocx({ bodyXml: TABLE, extraRels: RELS })
  const parsed = await parseDocx(source)
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: blocksToPmDoc(parsed.blocks) as never,
  })
  return { editor, parsed }
}

describe('rich table cell edits', () => {
  it('keeps hyperlink and per-run formatting when the cell text is edited', async () => {
    const { editor, parsed } = await openDoc()
    let at = -1
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'contact ') at = pos + 'contact'.length
    })
    expect(at).toBeGreaterThan(-1)
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, at)).insertText('X', at),
    )
    const plan = pmDocToSavePlan(editor.state.doc.toJSON() as PmNode, parsed.blocks)
    expect(plan.changedCount).toBe(1)
    const xml = plan.saveBlocks
      .map((b) => (b as { xml?: string }).xml ?? '')
      .find((x) => x.includes('w:tbl'))
    expect(xml).toBeTruthy()
    expect(xml).toContain('contactX ')
    // hyperlink wrapper + relationship id survive
    expect(xml).toContain('<w:hyperlink r:id="rId9">')
    expect(xml).toContain('>mail us</w:t>')
    // per-run formatting of the sibling run survives
    expect(xml).toMatch(/<w:b\/>[\s\S]{0,40}<w:t xml:space="preserve"> now<\/w:t>/)
    // untouched second paragraph and neighbor cell keep original bytes
    expect(xml).toContain('<w:p><w:r><w:rPr><w:i/></w:rPr><w:t>second para</w:t></w:r></w:p>')
    expect(xml).toContain('<w:t>other cell</w:t>')
  })
})

it.each(['setMatchedFont', 'setFont'] as const)(
  'saves 14pt for only the requested phrase in a table with %s',
  async (op) => {
    const phrase = '법령에 따라'
    const bodyXml = TABLE.replace(
      '<w:r><w:t xml:space="preserve">contact </w:t></w:r>',
      '<w:r><w:rPr><w:sz w:val="26"/></w:rPr><w:t>앞 법령에</w:t></w:r>' +
        '<w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t xml:space="preserve"> 따라 뒤</w:t></w:r>',
    )
    const parsed = await parseDocx(await buildDocx({ bodyXml, extraRels: RELS }))
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: blocksToPmDoc(parsed.blocks) as never,
    })
    try {
      const before = editor.state.doc
      let from = -1
      before.descendants((node, pos) => {
        if (node.text === '앞 법령에') from = pos + 2
      })
      expect(from).toBeGreaterThan(-1)
      editor.commands.setTextSelection({ from, to: from + phrase.length })
      const outcome = executeOps(editor, [
        op === 'setFont'
          ? { op, target: { scope: 'selection' }, fontSize: 14 }
          : { op, text: phrase, target: { nodeType: 'table' }, fontSize: 14 },
      ])
      expect(outcome.results[0].changed).toBe(1)
      const plan = pmDocToSavePlan(editor.state.doc.toJSON() as PmNode, parsed.blocks)
      const xml = (plan.saveBlocks[0] as { xml: string }).xml
      const reopened = await parseDocx(await saveDocx(parsed, plan.saveBlocks))
      const doc = editor.schema.nodeFromJSON(blocksToPmDoc(reopened.blocks))
      const runs: unknown[] = []
      doc.firstChild!.firstChild!.firstChild!.firstChild!.forEach((node) => {
        runs.push([
          node.text,
          node.marks.find((m) => m.type.name === 'docTextStyle')?.attrs.sizeHalfPoints,
          node.marks.some((m) => m.type.name === 'bold'),
        ])
      })
      expect(runs).toEqual(
        expect.arrayContaining([
          ['앞 ', 26, false],
          ['법령에', 28, false],
          [' 따라 뒤', 28, true],
        ]),
      )
      expect(xml).toContain('<w:gridCol w:w="4000"/>')
      expect(xml).toContain('<w:t>other cell</w:t>')
      expect(editor.commands.undo()).toBe(true)
      expect(editor.state.doc.eq(before)).toBe(true)
    } finally {
      editor.destroy()
    }
  },
)
