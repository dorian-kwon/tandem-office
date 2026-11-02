import type { WebContents } from 'electron'

/**
 * The shell's guard for a read-only editor view (the source pane of the
 * translation view). The editors know nothing about read-only, and their code
 * is not changed for it, so the guard sits at the two boundaries the shell
 * owns for one view:
 *
 * - Keyboard: `before-input-event` cancels every key that would type, delete,
 *   paste, undo or save, before the page or a menu accelerator sees it. Moving,
 *   selecting, copying, finding and zooming still work.
 * - IPC: handlers on the view's own `webContents.ipc` answer the editors' save
 *   channels with a failure. Electron looks there before `ipcMain`, so the
 *   editor's real handler never runs for this view, and other views are not
 *   affected.
 *
 * Mouse edits (drag and drop, context-menu paste), AI edits and the channels
 * that are not listed below are not covered; the translation view keeps the
 * source as a copy in the project's `source/` folder and checks its hash when
 * it opens, so the person's original file is never the one in this pane.
 */

export interface ReadOnlyKeyInput {
  type: string
  key: string
  control: boolean
  meta: boolean
  alt: boolean
  shift: boolean
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph', 'Fn'])
const NAVIGATION_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Escape',
])
/** chords allowed with the command modifier: copy, select all, find, print,
 *  close, quit, new/open, settings, zoom, tab cycling */
const COMMAND_KEYS = new Set([
  'c',
  'a',
  'f',
  'g',
  'p',
  'w',
  'q',
  'n',
  'o',
  't',
  ',',
  '=',
  '+',
  '-',
  '0',
  'tab',
])

const isFunctionKey = (key: string): boolean => /^F\d{1,2}$/.test(key)

/** True when a key press must not reach a read-only view. */
export function readOnlyBlocksInput(
  input: ReadOnlyKeyInput,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (input.type === 'keyUp') return false
  const { key } = input
  if (MODIFIER_KEYS.has(key) || NAVIGATION_KEYS.has(key) || isFunctionKey(key)) return false
  // Ctrl on Windows/Linux; on macOS both, since Ctrl+key still edits text there
  const command = platform === 'darwin' ? input.meta || input.control : input.control
  if (command) return !COMMAND_KEYS.has(key.toLowerCase())
  // everything else types, deletes, inserts or composes (IME reports 'Process')
  return true
}

const READ_ONLY_ERROR = 'This document is open read-only (translation source).'
const refused = { ok: false, error: READ_ONLY_ERROR } as const

/**
 * What a read-only view gets back on each channel. Every answer is a value
 * the editor already handles: a failed save `{ ok: false, error }`, a
 * cancelled Save As pick (null), or autosave off by default.
 */
export const READ_ONLY_IPC_ANSWERS: Readonly<Record<string, unknown>> = {
  // apps/docs/src/preload/index.ts
  'docs:save': refused,
  'docs:save-as-pick': null,
  'docs:save-as': refused,
  // apps/slides/src/preload/index.ts
  'slides:save': refused,
  'slides:save-as': refused,
  // MARKDOWN_CHANNELS.save, HTML_CHANNELS.save, EPUB_CHANNELS.save,
  // MINDMAP_CHANNELS.save (Save and Save As share the channel)
  'markdown:save': refused,
  'html:save': refused,
  'epub:save': refused,
  'mindmap:save': refused,
  // HWP_CHANNELS.beginSave (both modes)
  'hwp:begin-save': refused,
  // PDF_CHANNELS.save (in place, autosave and Save As) and the page edits that
  // rewrite the open file in place (apps/pdf/src/shared/ipc.ts); each answers
  // `{ ok: false, error }` on failure
  'pdf:save': refused,
  'pdf:insert-pdf': refused,
  'pdf:insert-blank-page': refused,
  'pdf:replace-pages': refused,
  'pdf:set-page-size': refused,
  'pdf:crop-pages': refused,
  // PDF_CHANNELS.autoRename renames the open file
  'pdf:auto-rename': { renamed: false },
  // the shell's own autosave default, read by every editor
  'app:get-auto-save-default': { on: false, updatedAt: 0 },
}

/**
 * Channels whose callers only know a thrown error as failure. The Sheets
 * editor's save strips Electron's "Error invoking remote method" wrapper and
 * shows the rest (apps/sheets/src/renderer/save-actions.ts), so these reject.
 */
export const READ_ONLY_IPC_THROWS: readonly string[] = [
  // IPC_CHANNELS.saveWorkbook and saveEditsBegin (apps/sheets/src/shared/ipc-channels.ts):
  // the direct save and the chunked transfer a large save starts with
  'workbook:save',
  'workbook:save-edits-begin',
]

type GuardedContents = Pick<WebContents, 'on' | 'removeListener'> & {
  ipc?: Pick<WebContents['ipc'], 'handle' | 'removeHandler'>
}

/** Install the guard on one view; returns the function that removes it. */
export function installReadOnlyGuard(contents: GuardedContents): () => void {
  const onInput = (event: Electron.Event, input: Electron.Input): void => {
    if (readOnlyBlocksInput(input)) event.preventDefault()
  }
  contents.on('before-input-event', onInput)
  // a handler on the view's own ipc is found before ipcMain's (Electron's
  // WebContents.ipc docs), so the editor's real handler never runs for it
  const channels = [...Object.keys(READ_ONLY_IPC_ANSWERS), ...READ_ONLY_IPC_THROWS]
  for (const channel of Object.keys(READ_ONLY_IPC_ANSWERS)) {
    const answer = READ_ONLY_IPC_ANSWERS[channel]
    contents.ipc?.handle(channel, () => answer)
  }
  for (const channel of READ_ONLY_IPC_THROWS) {
    contents.ipc?.handle(channel, () => {
      throw new Error(READ_ONLY_ERROR)
    })
  }
  return () => {
    contents.removeListener('before-input-event', onInput)
    for (const channel of channels) contents.ipc?.removeHandler(channel)
  }
}
