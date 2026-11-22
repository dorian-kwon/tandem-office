import { Extension, type Editor } from '@tiptap/core'
import { closeHistory, isHistoryTransaction } from '@tiptap/pm/history'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { SAVE_REBASE } from '../save-reload'
import { aiEditUndoHistoryEnabled } from '@genoffice/ui'

/** Only the synchronous dispatch of an AI command is scoped. Waiting for a tool must
 * never capture a person's typing or ribbon edits in another event turn. */
type AiOrigin = 'chat' | 'mcp'
let activeOrigin: AiOrigin | undefined
export const aiEditInFlight = (): boolean => activeOrigin !== undefined

export function withAiEdit<T>(run: () => T, origin: AiOrigin = activeOrigin ?? 'chat'): T {
  const previous = activeOrigin
  activeOrigin = origin
  try {
    return run()
  } finally {
    activeOrigin = previous
  }
}

const facades = { chat: new WeakMap<Editor, Editor>(), mcp: new WeakMap<Editor, Editor>() }
const originals = new WeakMap<Editor, Editor>()
export const originalAiEditor = (editor: Editor): Editor => originals.get(editor) ?? editor

/** The AI owns this facade, so a delayed image fetch or streamed draft tags only
 * its own dispatch. The real editor used by DOM input remains untouched. */
export function aiEditor(editor: Editor, origin: AiOrigin = 'chat'): Editor {
  if (originals.has(editor)) return editor
  const editors = facades[origin]
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
          }, origin)
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
                withAiEdit(() => view.dispatch(tr), origin)
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

// Start the first mutation of a new chat turn in its own native event. Capturing
// before a read must not insert an editor transaction or split ordinary typing.
const pendingChatBoundary = new WeakSet<Editor>()
export function markAiHistoryBoundary(editor: Editor): void {
  pendingChatBoundary.add(originalAiEditor(editor))
}

// A chat checkpoint can cross other chat edits and save metadata, but never another writer.
const historyOrigin = new PluginKey<{
  origin?: AiOrigin
  checkpoint: object
  fileBaseline: object
}>('aiHistoryOrigin')
export const rollbackCheckpoint = (editor: Editor) =>
  historyOrigin.getState(editor.state)?.checkpoint

export const rollbackFileBaseline = (editor: Editor) =>
  historyOrigin.getState(editor.state)?.fileBaseline

export const AiHistoryGateExtension = Extension.create({
  name: 'aiHistoryGate',
  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin({
        key: historyOrigin,
        state: {
          init: () => ({ checkpoint: {}, fileBaseline: {} }),
          apply(tr, previous) {
            if (!tr.docChanged) return previous
            if (tr.getMeta(SAVE_REBASE)) return { ...previous, fileBaseline: {} }
            const origin: AiOrigin | undefined = tr.getMeta(historyOrigin)
            return {
              origin,
              fileBaseline: previous.fileBaseline,
              checkpoint:
                origin === 'chat' && aiEditUndoHistoryEnabled() ? previous.checkpoint : {},
            }
          },
        },
        filterTransaction(tr, state) {
          if (!tr.docChanged || tr.getMeta(SAVE_REBASE)) return true
          const origin =
            tr.getMeta('uiEvent') === undefined && !isHistoryTransaction(tr)
              ? activeOrigin
              : undefined
          if (origin) tr.setMeta(historyOrigin, origin)
          // Otherwise adjacent AI and human insertions within the history delay undo together.
          if (
            (origin === 'chat' && pendingChatBoundary.delete(editor)) ||
            historyOrigin.getState(state)?.origin !== origin
          )
            closeHistory(tr)
          if (origin && !aiEditUndoHistoryEnabled() && tr.getMeta('addToHistory') === undefined) {
            tr.setMeta('addToHistory', false)
          }
          return true
        },
      }),
    ]
  },
})
