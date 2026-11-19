import { UndoRedo } from '@tiptap/extensions'
import { closeHistory, history } from '@tiptap/pm/history'
import { EditorState, Plugin, type Transaction } from '@tiptap/pm/state'

// The editor renders and paginates once per tool call. The history plugin
// receives the same validated steps in paragraph-sized groups.
const unitEnds = 'translationUnitEnds'
export function finishTranslationUnit(tr: Transaction): void {
  if (!tr.steps.length) return
  const ends: number[] = tr.getMeta(unitEnds) ?? []
  if (ends.at(-1) !== tr.steps.length) ends.push(tr.steps.length)
  tr.setMeta(unitEnds, ends)
}

export function visitTranslationUnits(
  tr: Transaction,
  state: EditorState,
  visit: (unit: Transaction, before: EditorState) => void,
): void {
  const ends: number[] = tr.getMeta(unitEnds) ?? []
  let shadow = EditorState.create({
    doc: state.doc,
    selection: state.selection,
    storedMarks: state.storedMarks,
  })
  let start = 0
  for (const end of [...ends, tr.steps.length]) {
    if (end === start) continue
    const part = closeHistory(shadow.tr)
    while (start < end) part.step(tr.steps[start++]!)
    visit(part, shadow)
    shadow = shadow.apply(part)
  }
}

export function translationHistory(config?: Parameters<typeof history>[0]) {
  const plugin = history(config)
  const regular = plugin.spec.state!
  const extended = history({ ...config, depth: Math.max(5000, config?.depth ?? 0) }).spec.state!
  let field = regular
  return new Plugin({
    ...plugin.spec,
    state: {
      ...field,
      apply(tr, value, before, after) {
        if (!tr.getMeta(unitEnds) || tr.getMeta('addToHistory') === false)
          return field.apply.call(this, tr, value, before, after)
        field = extended
        visitTranslationUnits(tr, before, (part, state) => {
          value = field.apply.call(this, part, value, state, after)
        })
        // Leave the final event open for normalizing transactions appended by
        // table plugins. AiHistoryGate closes it before the next manual edit.
        return value
      },
    },
  })
}
export const TranslationUndoRedo = UndoRedo.extend({
  addProseMirrorPlugins() {
    return [translationHistory(this.options)]
  },
})
