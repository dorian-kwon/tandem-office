import { HOME_CHANNELS } from '../shared/home-api'

interface FolderRecipient {
  isDestroyed(): boolean
  send(channel: string, dirs: string[]): void
}

/** Broadcast a filesystem change to the shell and editor views. */
export function notifyFolderChanged(recipients: readonly FolderRecipient[], dirs: string[]): void {
  for (const contents of recipients) {
    if (contents.isDestroyed()) continue
    try {
      contents.send(HOME_CHANNELS.folderChanged, dirs)
    } catch (error) {
      // Closed docs tabs retain their webContents after releasing the renderer.
      // A live webContents can therefore have no frame left to receive this event.
      if (
        error instanceof Error &&
        (error.message.startsWith('Render frame was disposed') ||
          error.message === 'Object has been destroyed')
      )
        continue
      throw error
    }
  }
}
