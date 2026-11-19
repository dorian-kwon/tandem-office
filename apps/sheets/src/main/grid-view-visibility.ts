import type { WebContentsView } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels'

// Only sheet views need this signal. A hidden WebContentsView with background
// throttling disabled can still report document.hidden === false.
const visibleSheets = new WeakMap<WebContentsView, boolean>()

export function trackSheetViewVisibility(view: WebContentsView): void {
  view.webContents.on('dom-ready', () => {
    const visible = view.getVisible()
    visibleSheets.set(view, visible)
    view.webContents.send(IPC_CHANNELS.gridViewVisibility, visible)
  })
}

export function setEditorViewVisible(
  view: WebContentsView | null | undefined,
  visible: boolean,
): void {
  if (!view) return
  view.setVisible(visible)
  if (
    visibleSheets.has(view) &&
    visibleSheets.get(view) !== visible &&
    !view.webContents.isDestroyed()
  ) {
    visibleSheets.set(view, visible)
    view.webContents.send(IPC_CHANNELS.gridViewVisibility, visible)
  }
}
