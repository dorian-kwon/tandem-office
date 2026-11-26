import type { Editor } from '@tiptap/core'
import { countWords } from '../word-count'
import { redactDocRange } from './redact-view'

interface SelectionPreview {
  text: string
  words: number
}

/** Reuse the preview between composer keystrokes. A mark-only edit also replaces the document. */
export function createSelectionPreviewReader(editor: Editor): () => SelectionPreview | undefined {
  let previous:
    | {
        doc: Editor['state']['doc']
        from: number
        to: number
        preview: SelectionPreview | undefined
      }
    | undefined

  return () => {
    const { doc, selection } = editor.state
    const { from, to } = selection
    if (selection.empty) {
      previous = undefined
      return undefined
    }
    if (previous?.doc === doc && previous.from === from && previous.to === to) {
      return previous.preview
    }

    const text = redactDocRange(doc, from, to, ' ').replace(/\s+/g, ' ').trim()
    const preview = text ? { text, words: countWords(text) } : undefined
    previous = { doc, from, to, preview }
    return preview
  }
}
