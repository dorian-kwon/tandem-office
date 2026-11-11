import { describe, expect, it } from 'vitest'
import type { NoteInfo } from '@genoffice/docx-engine'
import type { AiNotesAccess, NoteRollbackSnapshot } from '../src/renderer/ai/note-ops'
import { captureNoteRollback, restoreNoteRollback } from '../src/renderer/ai/translation-rollback'

function notes() {
  let state: NoteRollbackSnapshot = {
    footnotes: [{ id: '1', text: 'Original footnote' }],
    endnotes: [{ id: '2', text: 'Original endnote' }],
  }
  const access: AiNotesAccess = {
    list: (kind) => state[kind === 'footnote' ? 'footnotes' : 'endnotes'],
    add: () => {
      throw new Error('unused')
    },
    remove: () => false,
    replace: () => false,
    restoreSnapshot: (next) => {
      state = next
    },
  }
  return { access, state: () => state }
}

describe('translation note rollback', () => {
  it('restores both note lists including a note deleted after translation', () => {
    const store = notes()
    const saved = captureNoteRollback(store.access)
    store.access.restoreSnapshot!({ footnotes: [], endnotes: [{ id: '2', text: 'Translated' }] })
    expect(restoreNoteRollback(store.access, saved)).toBe(true)
    expect(store.state()).toEqual({
      footnotes: [{ id: '1', text: 'Original footnote' }],
      endnotes: [{ id: '2', text: 'Original endnote' }],
    })
  })

  it('keeps independent snapshots when only notes changed and body identity stayed the same', () => {
    const store = notes()
    const first = captureNoteRollback(store.access)
    store.access.list('footnote')[0]!.text = 'Second version'
    const second = captureNoteRollback(store.access)
    expect(first?.footnotes[0]?.text).toBe('Original footnote')
    expect(second?.footnotes[0]?.text).toBe('Second version')
    restoreNoteRollback(store.access, first)
    store.access.list('footnote')[0]!.text = 'Edited after rollback'
    expect(first?.footnotes[0]?.text).toBe('Original footnote')
    restoreNoteRollback(store.access, first)
    expect(store.state().footnotes[0]?.text).toBe('Original footnote')
  })

  it('requires a complete restoration capability before capturing a note rollback', () => {
    const partial: AiNotesAccess = {
      list: () => [{ id: '1', text: 'Original' } satisfies NoteInfo],
      add: () => '2',
      remove: () => false,
      replace: () => false,
    }
    expect(captureNoteRollback(partial)).toBeUndefined()
    expect(captureNoteRollback(undefined)).toBeUndefined()
    expect(restoreNoteRollback(partial, { footnotes: [], endnotes: [] })).toBe(false)
    expect(restoreNoteRollback(undefined, undefined)).toBe(false)
  })
})
