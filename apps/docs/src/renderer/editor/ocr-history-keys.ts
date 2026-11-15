import { Extension } from '@tiptap/core'
import { runOcrRedo, runOcrUndo } from '../ocr-history-state'

/**
 * Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y first ask whether OCR text put into the document has something to
 * undo or redo. When it does not, the key goes on to the editor's own history as always.
 */
export const OcrHistoryKeysExtension = Extension.create({
  name: 'ocrHistoryKeys',
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      'Mod-z': () => runOcrUndo(),
      'Shift-Mod-z': () => runOcrRedo(),
      'Mod-y': () => runOcrRedo(),
    }
  },
})
