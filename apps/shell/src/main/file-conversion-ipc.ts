import {
  dialog,
  ipcMain,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron'
import { showOpenDialogWithMemory } from '@genoffice/electron-utils'
import type { Lang } from '@genoffice/i18n'
import { conversionWarning } from '../shared/conversion-warning'
import { FILE_CONVERSION_CHANNELS as CHANNELS } from '../shared/file-conversion'
import { CONVERSION_EXTENSIONS, FileConversionSession } from './file-conversion'
import { cliErrorMessage, type CliRunner } from './mcp/cli-runner'

export async function convertWithBundledCli(
  cli: CliRunner,
  input: string,
  format: string,
  output: string,
  lang: Lang,
) {
  const result = await cli.run(['convert', input, '--to', format, '--out', output], {
    timeoutMs: 600_000,
  })
  if (!result.ok) throw new Error(cliErrorMessage(result))
  if (result.json?.status === 'ok')
    return result.json.warnings?.map((warning) => conversionWarning(lang, warning)).join(' ')
}

export function registerFileConversionIpc(
  mainWindow: () => BrowserWindow | null,
  cli: () => CliRunner,
  filterLabel: () => string,
  language: () => Lang,
): void {
  const sessions = new WeakMap<WebContents, FileConversionSession>()
  function owner(event: IpcMainInvokeEvent): BrowserWindow {
    const win = mainWindow()
    if (
      !win ||
      win.isDestroyed() ||
      event.sender !== win.webContents ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error('File conversion is available in the main window.')
    return win
  }

  ipcMain.handle(CHANNELS.pick, async (event) => {
    const win = owner(event)
    const picked = await showOpenDialogWithMemory(dialog, win, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: filterLabel(), extensions: CONVERSION_EXTENSIONS }],
    })
    if (picked.canceled || win.isDestroyed()) return []
    const session = sessions.get(event.sender) ?? new FileConversionSession()
    sessions.set(event.sender, session)
    return session.pick(picked.filePaths)
  })
  ipcMain.handle(CHANNELS.run, (event, ids: unknown, target: unknown) => {
    const win = owner(event)
    const session = sessions.get(event.sender)
    if (!session) throw new Error('Choose the files to convert.')
    return session.run(
      ids,
      target,
      (input, format, output) => convertWithBundledCli(cli(), input, format, output, language()),
      (result) => event.sender.send(CHANNELS.progress, result),
      () => !win.isDestroyed() && !event.sender.isDestroyed(),
    )
  })
}
