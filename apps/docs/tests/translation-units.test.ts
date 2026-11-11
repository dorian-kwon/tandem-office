import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import type { NoteInfo } from '@genoffice/docx-engine'
import type { PmNode } from '../src/renderer/editor/convert'
import type { AiNotesAccess } from '../src/renderer/ai/note-ops'
import * as runGroups from '../src/renderer/ai/translate-runs'
import {
  applyRunTranslations,
  planNoteTranslations,
  recordTwins,
} from '../src/renderer/ai/translate-runs'
import { createChatDocumentTranslator } from '../src/renderer/ai/translation-chat'
import { carryDocSeen, executeTool, markDocSeen } from '../src/renderer/ai/tools'
import { applyAnchorOnlyReload, SAVED_DOCUMENT_RELOAD_META } from '../src/renderer/save-reload'
import { TRACK_IGNORE } from '../src/renderer/editor/revisions'
import {
  createTranslationUnitIndex,
  isVerifiedTranslationReload,
} from '../src/renderer/ai/translation-units'

const editors: Editor[] = []
afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
  vi.restoreAllMocks()
})
const p = (text: string): PmNode => ({ type: 'docParagraph', content: [{ type: 'text', text }] })
async function setup(blocks: PmNode[]) {
  const { editorExtensions } = await import('../src/renderer/editor/extensions')
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
  })
  editors.push(editor)
  editor.view.dispatch(
    editor.state.tr.replaceWith(
      0,
      editor.state.doc.content.size,
      blocks.map((b) => editor.schema.nodeFromJSON(b)),
    ),
  )
  return editor
}

describe('editor memory translation units', () => {
  it.each([
    ['cleanup', false],
    ['anchors', false],
    ['saved-content', false],
    ['cleanup', true],
    ['anchors', true],
    ['saved-content', true],
  ] as const)(
    'keeps 70 mixed units current across %s after two batches (tracked: %s)',
    async (reload, tracked) => {
      const body = Array.from({ length: 39 }, (_, i) => {
        const block = p(`Body source ${i}.`)
        if (i < 29)
          block.content!.push({
            type: 'docNoteRef',
            attrs: { kind: 'footnote', id: String(i + 1), num: i + 1 },
          })
        return block
      })
      body.push({
        type: 'docTable',
        content: [
          {
            type: 'docTableRow',
            content: [{ type: 'docTableCell', content: [p('Table first'), p('Table second')] }],
          },
        ],
      })
      const editor = await setup(body)
      let notes: NoteInfo[] = Array.from({ length: 29 }, (_, i) => ({
        id: String(i + 1),
        text: `Note source ${i}.`,
        richParas: [[{ text: `Note source ${i}.` }]],
      }))
      const access: AiNotesAccess = {
        list: (kind) => (kind === 'footnote' ? notes : []),
        add: () => '',
        remove: () => false,
        replace: (_kind, id, next) => {
          notes = notes.map((note) => (note.id === id ? next : note))
          return true
        },
      }
      markDocSeen(editor)
      const index = createTranslationUnitIndex(editor, () => access)
      expect(index.snapshot(undefined, true)).toHaveLength(70)
      let reloaded = false
      let requests = 0
      const translator = createChatDocumentTranslator({
        index,
        request: async ({ units }) => {
          requests++
          return JSON.stringify({
            translations: units.map((unit) => ({
              id: unit.id,
              segments: unit.segments.map((text) => `A longer translated version of ${text}`),
            })),
          })
        },
        apply: (blocks) => {
          const outcome = executeTool(
            editor,
            { id: 'apply', name: 'translate_blocks', input: { blocks } },
            { bullet: null, ordered: null },
            tracked ? { author: 'AI Assistant' } : undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            access,
          )
          if (outcome instanceof Promise)
            throw new Error('Unexpected asynchronous translation apply')
          return outcome
        },
        onBeforeCommit: () => {},
        onProgress: (result) => {
          if (reloaded || result.completed !== 24) return
          reloaded = true
          const before = editor.state.doc
          if (reload === 'cleanup') {
            let tr = editor.state.tr
            before.forEach((node, pos) => {
              if (node.attrs.aiChanged)
                tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, aiChanged: false })
            })
            editor.view.dispatch(tr)
          } else {
            const rebased = editor.getJSON() as PmNode
            rebased.content!.forEach((node, i) => {
              node.attrs = {
                ...node.attrs,
                docxIndex: i + 100,
                ...(reload === 'saved-content' && node.type === 'docParagraph'
                  ? { styleId: 'Normal' }
                  : {}),
              }
            })
            const mode = applyAnchorOnlyReload(editor, rebased)
            expect(mode).toBe(reload === 'anchors' ? 'anchors' : null)
            if (mode === null)
              editor
                .chain()
                .setMeta(TRACK_IGNORE, true)
                .setMeta(SAVED_DOCUMENT_RELOAD_META, before)
                .setContent(rebased as never)
                .run()
          }
          carryDocSeen(editor, before)
        },
      })
      const result = await translator.run({
        provider: 'codex',
        model: '',
        targetLanguage: 'Korean',
        includeNotes: true,
      })
      expect(reloaded).toBe(true)
      expect({ completed: result.completed, stale: result.stale, failed: result.failed }).toEqual({
        completed: 70,
        stale: 0,
        failed: 0,
      })
      const requestCount = requests
      const resumed = await translator.run({
        provider: 'codex',
        model: '',
        targetLanguage: 'Korean',
        includeNotes: true,
      })
      expect({
        completed: resumed.completed,
        reused: resumed.reused,
        stale: resumed.stale,
        failed: resumed.failed,
      }).toEqual({ completed: 0, reused: 70, stale: 0, failed: 0 })
      expect(requests).toBe(requestCount)
      translator.dispose()
      index.dispose()
    },
  )

  it.each(['source', 'segments', 'fixed', 'topology', 'provenance', 'unmarked'] as const)(
    'refuses saved reload preservation after a %s change',
    async (change) => {
      const editor = await setup([
        {
          type: 'docParagraph',
          content: [
            { type: 'text', text: 'Alpha' },
            { type: 'docNoteRef', attrs: { kind: 'footnote', id: '1', num: 1 } },
          ],
        },
        p('Beta'),
      ])
      const index = createTranslationUnitIndex(editor)
      const [before] = index.snapshot()
      const oldDoc = editor.state.doc
      const next = editor.getJSON() as PmNode
      if (change === 'source') next.content![0].content![0].text = 'Changed'
      if (change === 'segments')
        next.content![0].content = [
          { type: 'text', text: 'Al', marks: [{ type: 'italic' }] },
          { type: 'text', text: 'pha' },
          next.content![0].content![1],
        ]
      if (change === 'fixed') next.content![0].content![1].attrs!.id = '2'
      if (change === 'topology') next.content!.push({ type: 'docParagraph' })
      const chain = editor.chain().setMeta(TRACK_IGNORE, true)
      if (change !== 'unmarked')
        chain.setMeta(
          SAVED_DOCUMENT_RELOAD_META,
          change === 'provenance' ? editor.schema.nodeFromJSON(oldDoc.toJSON()) : oldDoc,
        )
      let verified = true
      editor.on('transaction', ({ transaction }) => {
        if (transaction.docChanged) verified = isVerifiedTranslationReload(transaction)
      })
      chain.setContent(next as never).run()
      expect(verified).toBe(false)
      expect(index.resolve(before)).toBeNull()
      index.dispose()
    },
  )

  it('extracts each immutable block once and extracts only one block after a local edit', async () => {
    const editor = await setup([p('Alpha'), p('Beta'), p('Gamma')])
    const extract = vi.spyOn(runGroups, 'groupsOf')
    const index = createTranslationUnitIndex(editor)
    expect(index.snapshot()).toHaveLength(3)
    expect(extract).toHaveBeenCalledTimes(3)
    index.snapshot()
    expect(extract).toHaveBeenCalledTimes(3)
    editor.view.dispatch(editor.state.tr.insertText('!', 2))
    expect(index.snapshot()[0].segments).toEqual(['A!lpha'])
    expect(extract).toHaveBeenCalledTimes(4)
  })

  it('extracts only the changed paragraph inside a table', async () => {
    const editor = await setup([
      {
        type: 'docTable',
        content: [
          {
            type: 'docTableRow',
            content: [{ type: 'docTableCell', content: [p('Alpha'), p('Beta'), p('Gamma')] }],
          },
        ],
      },
    ])
    const extract = vi.spyOn(runGroups, 'groupsOf')
    const index = createTranslationUnitIndex(editor)
    expect(index.snapshot()).toHaveLength(3)
    extract.mockClear()
    editor.view.dispatch(editor.state.tr.insertText('!', 5))
    expect(index.snapshot()[0].segments).toEqual(['A!lpha'])
    expect(extract).toHaveBeenCalledTimes(1)
  })

  it('reuses immutable extraction and refreshes only the edited unit', async () => {
    const editor = await setup([p('Alpha'), p('Beta')])
    const index = createTranslationUnitIndex(editor)
    const before = index.snapshot()
    expect(before.map((u) => u.segments)).toEqual([['Alpha'], ['Beta']])
    expect(index.snapshot()[0]).toBe(before[0])
    editor.view.dispatch(editor.state.tr.insertText('!', 2))
    const after = index.snapshot()
    expect(after[0].id).toBe(before[0].id)
    expect(after[0].version).toBeGreaterThan(before[0].version)
    expect(after[1]).toBe(before[1])
    expect(index.resolve(before[0])).toBeNull()
    expect(index.resolve(before[1])).toBe(after[1])
  })

  it('keeps duplicate paragraphs separate through insertion and deletion', async () => {
    const editor = await setup([p('Same'), p('Same')])
    const index = createTranslationUnitIndex(editor)
    const [first, second] = index.snapshot()
    expect(first.id).not.toBe(second.id)
    editor.view.dispatch(editor.state.tr.insert(0, editor.schema.nodeFromJSON(p('Same'))))
    expect(index.resolve(first)?.address).toEqual({ kind: 'body', index: 1 })
    expect(index.resolve(second)?.address).toEqual({ kind: 'body', index: 2 })
    editor.view.dispatch(editor.state.tr.delete(6, 12))
    expect(index.resolve(first)).toBeNull()
    expect(index.resolve(second)?.address).toEqual({ kind: 'body', index: 1 })
  })

  it('retires split and merged source identities', async () => {
    const editor = await setup([p('AlphaBeta')])
    const index = createTranslationUnitIndex(editor)
    const [whole] = index.snapshot()
    expect(whole.segments).toEqual(['AlphaBeta'])
    editor.view.dispatch(editor.state.tr.split(6))
    expect(index.resolve(whole)).toBeNull()
    const pieces = index.snapshot()
    editor.view.dispatch(editor.state.tr.join(7))
    expect(pieces.every((unit) => index.resolve(unit) === null)).toBe(true)
  })

  it('follows an unambiguous immutable node move but resets on full replacement', async () => {
    const editor = await setup([p('Alpha'), p('Beta'), p('Gamma')])
    const index = createTranslationUnitIndex(editor)
    const [first] = index.snapshot()
    const node = editor.state.doc.child(0)
    const tr = editor.state.tr.delete(0, node.nodeSize)
    tr.insert(tr.doc.content.size, node)
    editor.view.dispatch(tr)
    expect(index.resolve(first)?.address).toEqual({ kind: 'body', index: 2 })
    editor.view.dispatch(
      editor.state.tr.replaceWith(0, editor.state.doc.content.size, editor.state.doc.content),
    )
    expect(index.resolve(first)).toBeNull()
  })

  it('follows an immutable paragraph moved within its table cell', async () => {
    const editor = await setup([
      {
        type: 'docTable',
        content: [
          {
            type: 'docTableRow',
            content: [{ type: 'docTableCell', content: [p('Alpha'), p('Beta')] }],
          },
        ],
      },
    ])
    const index = createTranslationUnitIndex(editor)
    const [before] = index.snapshot()
    const cell = editor.state.doc.child(0).child(0).child(0)
    editor.view.dispatch(editor.state.tr.replaceWith(3, 16, [cell.child(1), cell.child(0)]))
    expect(index.resolve(before)?.address).toEqual({ kind: 'body', index: 0, paragraph: 1 })
  })

  it('retires a recreated block even when its exact text is unchanged', async () => {
    const editor = await setup([p('Alpha'), p('Beta')])
    const index = createTranslationUnitIndex(editor)
    const [before] = index.snapshot()
    editor.view.dispatch(editor.state.tr.replaceWith(0, 7, editor.schema.nodeFromJSON(p('Alpha'))))
    expect(index.resolve(before)).toBeNull()
    expect(index.snapshot()[0].id).not.toBe(before.id)
  })

  it('checks exact segments despite fingerprint ambiguity and rejects fixed-object changes', async () => {
    const editor = await setup([
      p('A\u0001B'),
      {
        type: 'docParagraph',
        content: [{ type: 'text', text: 'A' }, { type: 'hardBreak' }, { type: 'text', text: 'B' }],
      },
    ])
    const index = createTranslationUnitIndex(editor)
    const [one, two] = index.snapshot()
    expect(one.fp).toBe(two.fp)
    expect(index.resolve({ ...one, segments: two.segments })).toBeNull()
    editor.view.dispatch(editor.state.tr.insert(2, editor.schema.nodes.hardBreak.create()))
    expect(index.resolve(one)).toBeNull()
  })

  it('preserves compatible format changes but invalidates segmentation changes', async () => {
    const editor = await setup([p('Alpha')])
    const index = createTranslationUnitIndex(editor)
    const [before] = index.snapshot()
    editor.view.dispatch(
      editor.state.tr.addMark(1, 6, editor.schema.marks.docTextStyle.create({ font: 'Arial' })),
    )
    expect(index.resolve(before)).not.toBeNull()
    editor.view.dispatch(
      editor.state.tr.addMark(1, 3, editor.schema.marks.docTextStyle.create({ font: 'Batang' })),
    )
    expect(index.resolve(before)).toBeNull()
  })

  it('excludes redacted text, empty blocks and bilingual twins and addresses table paragraphs', async () => {
    const editor = await setup([
      p('Original'),
      p('Translation'),
      { type: 'docParagraph' },
      {
        type: 'docParagraph',
        content: [
          { type: 'text', text: 'secret', marks: [{ type: 'redaction' }] },
          { type: 'text', text: 'Public' },
        ],
      },
      {
        type: 'docTable',
        content: [
          { type: 'docTableRow', content: [{ type: 'docTableCell', content: [p('Cell')] }] },
        ],
      },
    ])
    const index = createTranslationUnitIndex(editor)
    const initial = index.snapshot()
    recordTwins(editor, [[initial[0].fp, initial[1].fp]])
    const units = index.snapshot()
    expect(units.map((u) => u.segments)).toEqual([['Public'], ['Cell']])
    expect(units[1].address).toEqual({ kind: 'body', index: 4, paragraph: 0 })
    expect(index.snapshot({ startBlockIndex: 4, endBlockIndex: 4 })).toEqual([units[1]])
  })

  it('commits separate paragraphs of one note without invalidating siblings or completed receipts', async () => {
    const editor = await setup([p('Body')])
    let note: NoteInfo = {
      id: '1',
      text: 'Alpha\nBeta',
      richParas: [[{ text: 'Alpha' }], [{ text: 'Beta', italic: true }]],
    }
    const access: AiNotesAccess = {
      list: (kind) => (kind === 'footnote' ? [note] : []),
      add: () => '',
      remove: () => false,
      replace: (_kind, _id, next) => {
        note = next
        return true
      },
    }
    const index = createTranslationUnitIndex(editor, () => access)
    const [, alpha, beta] = index.snapshot(undefined, true)
    const commit = (unit: typeof alpha, segments: string[]) => {
      const resolved = index.resolve(unit)
      expect(resolved).not.toBeNull()
      if (!resolved || resolved.address.kind !== 'note') throw new Error('Note became stale')
      const { kind: _kind, ...address } = resolved.address
      const plan = planNoteTranslations(access, [{ ...address, fp: resolved.fp, segments }])
      expect(plan.ok).toBe(true)
      if (!plan.ok) throw new Error('Note plan failed')
      for (const next of plan.next) access.replace(next.kind, next.note.id, next.note)
      return index.current(unit.id)!
    }
    const receipt = commit(alpha, ['First'])
    expect(index.resolve(beta)).not.toBeNull()
    commit(beta, ['Second'])
    expect(note.text).toBe('First\nSecond')
    expect(index.resolve(receipt)).not.toBeNull()
    note = { ...note, text: 'First\nSecond\nThird' }
    expect(index.resolve(receipt)).toBeNull()
  })

  it('keeps post-write receipts through formatted translation and highlight attribute cleanup', async () => {
    const editor = await setup([p('Alpha'), p('Beta')])
    const index = createTranslationUnitIndex(editor)
    const [before, sibling] = index.snapshot()
    expect(
      applyRunTranslations(editor, [{ index: 0, fp: before.fp, segments: ['Translated'] }]).ok,
    ).toBe(true)
    const receipt = index.current(before.id)
    expect(receipt?.segments).toEqual(['Translated'])
    expect(index.resolve(sibling)).not.toBeNull()
    const node = editor.state.doc.child(0)
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(0, undefined, { ...node.attrs, aiChanged: false }),
    )
    expect(index.resolve(receipt!)).not.toBeNull()
    expect(index.resolve(before)).toBeNull()
  })

  it('does not authorize a unit from an earlier index lifetime', async () => {
    const editor = await setup([p('Body')])
    const first = createTranslationUnitIndex(editor)
    const [before] = first.snapshot()
    first.dispose()
    const next = createTranslationUnitIndex(editor)
    expect(next.resolve(before)).toBeNull()
  })

  it('rechecks note edits outside PM and disposes all identities', async () => {
    const editor = await setup([p('Body')])
    let note = { id: '1', text: 'Note' }
    const access = {
      list: (kind: string) => (kind === 'footnote' ? [note] : []),
    } as unknown as AiNotesAccess
    const index = createTranslationUnitIndex(editor, () => access)
    const units = index.snapshot(undefined, true)
    expect(units[1].address).toEqual({ kind: 'note', note: 'footnote', id: '1' })
    note = { id: '1', text: 'Edited' }
    expect(index.resolve(units[1])).toBeNull()
    const current = index.current(units[1].id)!
    expect(current.segments).toEqual(['Edited'])
    expect(current.version).toBeGreaterThan(units[1].version)
    index.dispose()
    expect(index.snapshot()).toEqual([])
    expect(index.current(current.id)).toBeUndefined()
  })
})
