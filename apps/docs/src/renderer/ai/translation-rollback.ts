import type { AiNotesAccess, NoteRollbackSnapshot } from './note-ops'

/** Independent of PM node identity: a note can change without a body transaction. */
export function captureNoteRollback(access?: AiNotesAccess): NoteRollbackSnapshot | undefined {
  if (!access?.restoreSnapshot) return undefined
  return structuredClone({
    footnotes: access.list('footnote'),
    endnotes: access.list('endnote'),
  })
}

export function restoreNoteRollback(
  access: AiNotesAccess | undefined,
  snapshot: NoteRollbackSnapshot | undefined,
): boolean {
  if (!access?.restoreSnapshot || !snapshot) return false
  access.restoreSnapshot(structuredClone(snapshot))
  return true
}
