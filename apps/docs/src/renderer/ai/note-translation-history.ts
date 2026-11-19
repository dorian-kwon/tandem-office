import type { Editor } from '@tiptap/core'
import type { Node } from '@tiptap/pm/model'
import { Step, StepResult } from '@tiptap/pm/transform'
import type { NoteInfo, NoteRun } from '@genoffice/docx-engine'
import { originalAiEditor } from './ai-history-gate'
import type { AiNotesAccess, NoteKind } from './note-ops'

type Paragraph = { text: string; runs?: NoteRun[]; restoreRich?: NoteRun[][] }
export interface NoteUnit {
  kind: NoteKind
  id: string
  index: number
  afterBody: number
  before: Paragraph
  after: Paragraph
}
export const noteParagraph = (note: NoteInfo, index: number, restoreRich = false): Paragraph => ({
  ...(restoreRich ? { restoreRich: note.richParas } : {}),
  text: note.text.split('\n')[index]!,
  runs: note.richParas?.[index],
})

// Footnotes live in their own DOCX part. This identity step lets their edits
// interleave with paragraph history without inserting anything in the body.
// Planning, validation and history replay are pure; only a committed view
// transaction writes through to the note store.
class NoteStep extends Step {
  constructor(
    readonly unit: NoteUnit,
    readonly access: AiNotesAccess,
  ) {
    super()
  }
  apply(doc: Node) {
    return StepResult.ok(doc)
  }
  invert() {
    return new NoteStep(
      { ...this.unit, before: this.unit.after, after: this.unit.before },
      this.access,
    )
  }
  map() {
    return this
  }
  toJSON() {
    return { stepType: 'localNoteTranslation' }
  }
  commit() {
    const { kind, id, index, before, after } = this.unit
    const note = this.access.list(kind).find((n) => n.id === id)
    if (!note) return
    const lines = note.text.split('\n')
    if (lines[index] !== before.text) return
    const runs = note.richParas?.[index]
    if (runs !== before.runs && JSON.stringify(runs) !== JSON.stringify(before.runs)) return
    lines[index] = after.text
    const next = { ...note, text: lines.join('\n') }
    if (after.restoreRich) next.richParas = after.restoreRich
    else if (!after.runs) delete next.richParas
    if (note.richParas && after.runs) {
      next.richParas = note.richParas.slice()
      next.richParas[index] = after.runs
    }
    this.access.replace(kind, id, next)
  }
}

const observed = new WeakSet<Editor>()
export function noteTranslationSteps(editor: Editor, access: AiNotesAccess, units: NoteUnit[]) {
  const owner = originalAiEditor(editor)
  if (!observed.has(owner)) {
    observed.add(owner)
    owner.on('transaction', ({ transaction, appendedTransactions }) => {
      for (const tr of [transaction, ...appendedTransactions])
        for (const step of tr.steps) if (step instanceof NoteStep) step.commit()
    })
  }
  return units.map((unit) => ({ afterBody: unit.afterBody, step: new NoteStep(unit, access) }))
}
