import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { runAiHistoryRequest } from './session-state'

/** A separate channel carries the AI source; the ordinary channel remains a human edit. */
export function handleAiEditable(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: any[]) => any,
): void {
  ipcMain.handle(channel, handler)
  ipcMain.handle(`${channel}:ai-edit`, (event, args: unknown[], recordUndo: boolean) =>
    runAiHistoryRequest(recordUndo === true, () => handler(event, ...args)),
  )
}
