import { Extension, type Editor } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { aiEditUndoHistoryEnabled } from '@genoffice/ui'

/** Only the synchronous dispatch of an AI command is scoped. Waiting for a tool must
 * never capture a person's typing or ribbon edits in another event turn. */
let depth = 0
export const aiEditInFlight = (): boolean => depth > 0

export function withAiEdit<T>(run: () => T): T {
  depth += 1
  try {
    return run()
  } finally {
    depth -= 1
  }
}

const editors = new WeakMap<Editor, Editor>()
const originals = new WeakMap<Editor, Editor>()
export const originalAiEditor = (editor: Editor): Editor => originals.get(editor) ?? editor

/** The AI owns this facade, so a delayed image fetch or streamed draft tags only
 * its own dispatch. The real editor used by DOM input remains untouched. */
export function aiEditor(editor: Editor): Editor {
  if (originals.has(editor)) return editor
  const cached = editors.get(editor)
  if (cached) return cached
  const chain = (commands: object): object =>
    new Proxy(commands, {
      get(target, key) {
        const value = Reflect.get(target, key)
        if (typeof value !== 'function') return value
        return (...args: unknown[]) =>
          withAiEdit(() => {
            const result = Reflect.apply(value, target, args)
            return result === target ? chain(target) : result
          })
      },
    })
  const facade = new Proxy(editor, {
    get(target, key) {
      if (key === 'commands') return chain(target.commands)
      if (key === 'chain') return () => chain(target.chain())
      if (key === 'view')
        return new Proxy(target.view, {
          get(view, name) {
            if (name === 'dispatch')
              return (tr: Parameters<typeof view.dispatch>[0]) =>
                withAiEdit(() => view.dispatch(tr))
            const value = Reflect.get(view, name, view)
            return typeof value === 'function' ? value.bind(view) : value
          },
        })
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  editors.set(editor, facade)
  originals.set(facade, editor)
  return facade
}

export const AiHistoryGateExtension = Extension.create({
  name: 'aiHistoryGate',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        // Marking in the filter runs before the history plugin reads the transaction.
        filterTransaction(tr) {
          if (
            depth > 0 &&
            !aiEditUndoHistoryEnabled() &&
            tr.docChanged &&
            // the person pasting, dropping or cutting while a tool runs is still the person's edit
            tr.getMeta('uiEvent') === undefined &&
            // undo/redo themselves and an explicit choice either way stay as they are
            tr.getMeta('history$') === undefined &&
            tr.getMeta('addToHistory') === undefined
          ) {
            tr.setMeta('addToHistory', false)
          }
          return true
        },
      }),
    ]
  },
})
