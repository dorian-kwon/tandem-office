import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import JSZip from 'jszip'
import { parseDocx, saveDocx, type TableModel } from '@genoffice/docx-engine'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { blocksToPmDoc, pmDocToSavePlan, type PmNode } from '../src/renderer/editor/convert'
import { buildDocx, NESTED_TABLE_XML } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { readRunGroups } from '../src/renderer/ai/translate-runs'
import { executeTool } from '../src/renderer/ai/tools'

async function openNestedDoc() {
  const bytes = await buildDocx({ bodyXml: NESTED_TABLE_XML })
  const parsed = await parseDocx(bytes)
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: blocksToPmDoc(parsed.blocks) as never,
  })
  return { editor, parsed, bytes }
}

/** equivalent of the NodeView commit: mutate the docNestedTable model attribute */
function editNestedCell(editor: Editor, newText: string) {
  let done = false
  editor.state.doc.descendants((node, pos) => {
    if (done || node.type.name !== 'docNestedTable') return
    const model = node.attrs.model as TableModel
    const rows = model.rows.map((row, r) =>
      row.map((cell, c) => (r === 0 && c === 0 ? { ...cell, paras: [newText] } : cell)),
    )
    editor.view.dispatch(
      editor.view.state.tr.setNodeMarkup(pos, undefined, { model: { ...model, rows } }),
    )
    done = true
  })
  expect(done).toBe(true)
}

describe('nested table editing end to end', () => {
  it('undoes and redoes an interleaved batch in submission order across the outer and inner cells', async () => {
    const { editor } = await openNestedDoc()
    try {
      const original = editor.state.doc
      const rows = () => readRunGroups(editor, 0, 0).filter((e) => e.fp && e.segments?.length)
      const byText = new Map(rows().map((e) => [e.segments![0], e]))
      const ordered = ['InnerB', 'Outer', 'InnerA', 'RightCell']
      const blocks = ordered.map((source) => ({
        ...byText.get(source),
        segments: ['Translated ' + source],
      }))
      const result = await executeTool(
        editor,
        { id: 'batch', name: 'translate_blocks', input: { blocks } },
        { bullet: null, ordered: null },
      )
      expect(result.mutated).toBe(true)
      const check = (done: number) => {
        const live = rows().map((e) => e.segments![0])
        ordered.forEach((text, i) => expect(live).toContain(i < done ? 'Translated ' + text : text))
      }
      for (let i = 4; i > 0; i--) {
        check(i)
        expect(editor.commands.undo()).toBe(true)
      }
      expect(editor.state.doc.eq(original)).toBe(true)
      for (let i = 1; i <= 4; i++) {
        expect(editor.commands.redo()).toBe(true)
        check(i)
      }
    } finally {
      editor.destroy()
    }
  })

  it('applies outer and inner bilingual translations in one document transaction', async () => {
    const { editor, parsed } = await openNestedDoc()
    try {
      const run = (name: string, input: Record<string, unknown>) =>
        executeTool(editor, { id: name, name, input }, { bullet: null, ordered: null })
      const read = await run('read_runs', { startBlockIndex: 0, endBlockIndex: 0 })
      const blocks = read.output
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.fp && entry.segments)
        .map((entry) => ({
          ...entry,
          segments: entry.segments.map((text: string) => `Translation of ${text}`),
        }))
      expect(blocks).toHaveLength(4)
      let writes = 0
      editor.on('transaction', ({ transaction }) => {
        if (transaction.docChanged) writes++
      })
      const result = await run('add_bilingual', { layout: 'right', blocks })
      expect(result.isError).toBeFalsy()
      expect(writes).toBe(1)
      const { saved } = await savedBodyXml(parsed, editor)
      const table = (await parseDocx(saved)).blocks[0].table!
      expect(table.rows[0].map((cell) => cell.paras[0])).toEqual([
        'Outer',
        'Translation of Outer',
        'RightCell',
        'Translation of RightCell',
      ])
      expect(table.rows[0][0].nestedTables![0].rows[0].map((cell) => cell.paras[0])).toEqual([
        'InnerA',
        'Translation of InnerA',
        'InnerB',
        'Translation of InnerB',
      ])
    } finally {
      editor.destroy()
    }
  })

  it('adds bilingual columns to the inner table and saves tracked corrections only on the translations', async () => {
    const { editor, parsed } = await openStyledHost()
    const run = (name: string, input: Record<string, unknown>) =>
      executeTool(editor, { id: name, name, input }, { bullet: null, ordered: null })
    const read = async (review = false) => {
      const result = await run('read_runs', { startBlockIndex: 0, endBlockIndex: 0, review })
      return result.output
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line))
        .filter((line) => line.nestedTable === 0 && line.segments)
    }
    try {
      const initial = await read()
      expect(initial.map((entry) => entry.segments[0])).toEqual(['InnerA', 'InnerB'])
      const bilingual = await run('add_bilingual', {
        layout: 'right',
        blocks: initial.map((entry, i) => ({ ...entry, segments: [i === 0 ? 'Old A' : 'Old B'] })),
      })
      expect(bilingual.output).toContain('nested table 0')
      expect(bilingual.output).toContain('in a new column')
      expect(bilingual.mutated).toBe(true)
      const reviewed = await read(true)
      expect(reviewed.map((entry) => entry.role)).toEqual([
        'original',
        'translation',
        'original',
        'translation',
      ])
      const translated = reviewed.find((entry) => entry.segments[0] === 'Old B')
      const revision = await run('revise_blocks', {
        blocks: [{ ...translated, segments: ['New B'] }],
      })
      expect(revision.mutated).toBe(true)
      const { saved, xml } = await savedBodyXml(parsed, editor)
      expect(xml).toContain(RIGHT_CELL_XML)
      const table = (await parseDocx(saved)).blocks[0].table!
      expect(table.rows[0]).toHaveLength(2)
      const row = table.rows[0][0].nestedTables![0].rows[0]
      expect(row).toHaveLength(4)
      expect(row[0].paras).toEqual(['InnerA'])
      expect(row[1].paras).toEqual(['Old A'])
      expect(row[2].paras).toEqual(['InnerB'])
      expect(row[3].richParas?.[0].runs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            text: 'New',
            ins: expect.objectContaining({ author: 'AI Assistant (review)' }),
          }),
          expect.objectContaining({
            text: 'Old',
            del: expect.objectContaining({ author: 'AI Assistant (review)' }),
          }),
        ]),
      )
    } finally {
      editor.destroy()
    }
  })

  it('reads and translates deeply nested cells through the normal AI tools and saves the result', async () => {
    const deep =
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>깊은 표</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    const bodyXml = NESTED_TABLE_XML.replace(
      '<w:t>InnerA</w:t></w:r></w:p>',
      '<w:t>InnerA</w:t></w:r></w:p>' + deep + '<w:p/>',
    )
    const parsed = await parseDocx(await buildDocx({ bodyXml }))
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: blocksToPmDoc(parsed.blocks) as never,
    })
    const run = (name: string, input: Record<string, unknown>) =>
      executeTool(editor, { id: name, name, input }, { bullet: null, ordered: null })
    try {
      const read = await run('read_runs', { startBlockIndex: 0, endBlockIndex: 0 })
      const entries = read.output
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line))
      const inner = entries.find((entry) => entry.segments?.includes('InnerA'))
      const leaf = entries.find((entry) => entry.segments?.includes('깊은 표'))
      expect(inner).toMatchObject({ index: 0, nestedTable: 0, paragraph: 0 })
      expect(leaf).toMatchObject({ index: 0, nestedTable: 1, paragraph: 0 })
      const remaining = await run('read_runs', { checkRemaining: true, sourceLanguage: 'ko' })
      expect(remaining.output).toContain('nested table 1')
      const result = await run('translate_blocks', {
        blocks: [
          { ...inner, segments: ['Translated parent'] },
          { ...leaf, segments: ['Deep table'] },
        ],
      })
      expect(result.isError).toBeFalsy()
      expect(result.mutated).toBe(true)
      const plan = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
      expect(plan.changedCount).toBe(1)
      const reopened = await parseDocx(await saveDocx(parsed, plan.saveBlocks))
      const outer = reopened.blocks[0].table!
      expect(outer.rows[0][1].paras).toEqual(['RightCell'])
      const nested = outer.rows[0][0].nestedTables![0]
      expect(nested.rows[0][0].paras[0]).toBe('Translated parent')
      expect(nested.rows[0][1].paras).toEqual(['InnerB'])
      const restored = nested.rows[0][0].nestedTables![0].rows[0][0]
      expect(restored.richParas?.[0].runs[0]).toMatchObject({ text: 'Deep table', bold: true })
    } finally {
      editor.destroy()
    }
  })

  it('untouched round-trip is byte-identical', async () => {
    const { editor, parsed, bytes } = await openNestedDoc()
    const plan = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
    expect(plan.changedCount).toBe(0)
    expect(await saveDocx(parsed, plan.saveBlocks)).toEqual(bytes)
    editor.destroy()
  })

  it('nested-cell text edits use the surgical patch, outer bytes untouched', async () => {
    const { editor, parsed } = await openNestedDoc()
    editNestedCell(editor, 'EditedInnerA')
    const plan = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
    expect(plan.changedCount).toBe(1)
    const saved = await saveDocx(parsed, plan.saveBlocks)
    const reparsed = await parseDocx(saved)
    const outer = reparsed.blocks[0].table!
    expect(outer.rows[0][0].paras[0]).toBe('Outer')
    expect(outer.rows[0][1].paras[0]).toBe('RightCell')
    expect(outer.rows[0][0].nestedTables![0].rows[0].map((c) => c.paras[0])).toEqual([
      'EditedInnerA',
      'InnerB',
    ])
    editor.destroy()
  })

  it('outer structural change (formatting) no longer drops nested tables on regeneration', async () => {
    const { editor, parsed } = await openNestedDoc()
    // changing the right cell's shading changes the formatting signature, taking the whole-table regeneration path
    let done = false
    editor.state.doc.descendants((node, pos) => {
      if (done || node.type.name !== 'docTableCell') return true
      if (node.textContent !== 'RightCell') return true
      editor.view.dispatch(
        editor.view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, fill: 'FFFF00' }),
      )
      done = true
      return false
    })
    expect(done).toBe(true)
    const plan = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
    expect(plan.changedCount).toBe(1)
    const reparsed = await parseDocx(await saveDocx(parsed, plan.saveBlocks))
    const outer = reparsed.blocks[0].table!
    expect(outer.rows[0][1].fill).toBe('FFFF00')
    expect(outer.rows[0][0].nestedTables![0].rows[0].map((c) => c.paras[0])).toEqual([
      'InnerA',
      'InnerB',
    ])
    editor.destroy()
  })
})

// the DOM read-back is not a faithful text encoding of the model (a trailing
// empty paragraph renders as a stripped newline): only cells the user typed in
// may be committed, or every save rewrote the untouched nested cell lossily
const NESTED_TRAILING_EMPTY_XML = NESTED_TABLE_XML.replace(
  '<w:t>InnerA</w:t></w:r></w:p>',
  '<w:t>InnerA</w:t></w:r></w:p><w:p/>',
)

function nestedModel(editor: Editor): TableModel {
  let model: TableModel | null = null
  editor.state.doc.descendants((node) => {
    if (!model && node.type.name === 'docNestedTable') model = node.attrs.model as TableModel
  })
  return model!
}

describe('nested cell pre-save commit', () => {
  it('leaves untyped cells alone even when the DOM text differs from the model', async () => {
    const bytes = await buildDocx({ bodyXml: NESTED_TRAILING_EMPTY_XML })
    const parsed = await parseDocx(bytes)
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: blocksToPmDoc(parsed.blocks) as never,
    })
    expect(nestedModel(editor).rows[0][0].paras).toEqual(['InnerA', ''])
    window.dispatchEvent(new Event('ai-docs-commit-tables'))
    expect(nestedModel(editor).rows[0][0].paras).toEqual(['InnerA', ''])
    const plan = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
    expect(plan.changedCount).toBe(0)
    expect(await saveDocx(parsed, plan.saveBlocks)).toEqual(bytes)
    editor.destroy()
  })

  it('commits the cell the user typed in', async () => {
    const { editor } = await openNestedDoc()
    const td = editor.view.dom.querySelector('.doc-nested-table td') as HTMLElement
    td.textContent = 'Typed'
    td.dispatchEvent(new Event('input', { bubbles: true }))
    window.dispatchEvent(new Event('ai-docs-commit-tables'))
    expect(nestedModel(editor).rows[0].map((c) => c.paras[0])).toEqual(['Typed', 'InnerB'])
    editor.destroy()
  })
})

// a cell's own paragraphs beside a nested table: the engine's cell patch only
// reaches the nested tables, so typing there used to be dropped on save
const STYLED_HOST_XML = NESTED_TABLE_XML.replace(
  '<w:p><w:r><w:t>Outer</w:t>',
  '<w:p><w:pPr><w:pStyle w:val="Quote"/></w:pPr><w:r><w:t>Outer</w:t>',
).replace(
  '<w:p><w:r><w:t>RightCell</w:t>',
  '<w:p><w:pPr><w:pStyle w:val="Quote"/></w:pPr><w:r><w:t>RightCell</w:t>',
)
const INNER_TABLE_XML = /<w:tbl>(?:(?!<w:tbl>)[\s\S])*?InnerB[\s\S]*?<\/w:tbl>/.exec(
  STYLED_HOST_XML.slice(1),
)![0]
const RIGHT_CELL_XML =
  /<w:tc><w:p><w:pPr><w:pStyle w:val="Quote"\/><\/w:pPr><w:r><w:t>RightCell[\s\S]*?<\/w:tc>/.exec(
    STYLED_HOST_XML,
  )![0]

async function openStyledHost() {
  const bytes = await buildDocx({ bodyXml: STYLED_HOST_XML })
  const parsed = await parseDocx(bytes)
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: blocksToPmDoc(parsed.blocks) as never,
  })
  return { editor, parsed }
}

/** position just after the first character of `text` */
function afterFirstChar(editor: Editor, text: string): number {
  let at = -1
  editor.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text?.includes(text)) at = pos + node.text.indexOf(text) + 1
    return at < 0
  })
  expect(at).toBeGreaterThan(0)
  return at
}

async function savedBodyXml(parsed: Awaited<ReturnType<typeof parseDocx>>, editor: Editor) {
  const plan = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
  const saved = await saveDocx(parsed, plan.saveBlocks)
  const zip = await JSZip.loadAsync(saved)
  return { plan, saved, xml: await zip.file('word/document.xml')!.async('string') }
}

describe('typing in a cell that also holds a nested table', () => {
  it('saves the typing and keeps the paragraph styles, the nested table and the other cells', async () => {
    const { editor, parsed } = await openStyledHost()
    editor.view.dispatch(editor.state.tr.insertText('Z', afterFirstChar(editor, 'Outer')))
    const { plan, saved, xml } = await savedBodyXml(parsed, editor)
    expect(plan.changedCount).toBe(1)
    expect(xml).toContain(
      '<w:pPr><w:pStyle w:val="Quote"/></w:pPr><w:r><w:t xml:space="preserve">OZuter</w:t></w:r>',
    )
    expect(xml).toContain(INNER_TABLE_XML)
    expect(xml).toContain(RIGHT_CELL_XML)
    const outer = (await parseDocx(saved)).blocks[0].table!
    expect(outer.rows[0][0].paras[0]).toBe('OZuter')
    editor.destroy()
  })

  it('saves the outer cell and a nested cell edited together', async () => {
    const { editor, parsed } = await openStyledHost()
    editor.view.dispatch(editor.state.tr.insertText('Z', afterFirstChar(editor, 'Outer')))
    editNestedCell(editor, 'EditedInnerA')
    const { saved, xml } = await savedBodyXml(parsed, editor)
    expect(xml).toContain(RIGHT_CELL_XML)
    const outer = (await parseDocx(saved)).blocks[0].table!
    expect(outer.rows[0][0].paras[0]).toBe('OZuter')
    expect(outer.rows[0][0].nestedTables![0].rows[0].map((c) => c.paras[0])).toEqual([
      'EditedInnerA',
      'InnerB',
    ])
    editor.destroy()
  })

  it('still saves the typing when the outer cell gained a paragraph', async () => {
    const { editor, parsed } = await openStyledHost()
    editor.view.dispatch(editor.state.tr.split(afterFirstChar(editor, 'Outer') + 1))
    const { saved } = await savedBodyXml(parsed, editor)
    const outer = (await parseDocx(saved)).blocks[0].table!
    expect(outer.rows[0][0].paras.slice(0, 2)).toEqual(['Ou', 'ter'])
    expect(outer.rows[0][0].nestedTables![0].rows[0].map((c) => c.paras[0])).toEqual([
      'InnerA',
      'InnerB',
    ])
    editor.destroy()
  })
})
