import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Worker } from 'node:worker_threads'
import { isAbsolute, join } from 'node:path'
import {
  app,
  dialog,
  ipcMain,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron'
import { showOpenDialogWithMemory } from '@genoffice/electron-utils'
import type { Lang } from '@genoffice/i18n'
import { OCR_CHANNELS as channels, type OcrFileOptions } from '../shared/file-conversion'
import { pdfPageWarning } from '../shared/conversion-warning'
import { FileConversionSession } from './file-conversion'
import { OCR_EXTENSIONS, ocrTargets } from './ocr-targets'
import workerPath from './ocr-file-worker?modulePath'

function helperPath() {
  const name = process.platform === 'darwin' ? 'vision-ocr' : 'win-ocr.exe'
  return app.isPackaged
    ? join(process.resourcesPath, 'ocr', name)
    : join(app.getAppPath(), '../../packages/pdf2docx/ocr-helper', name)
}
async function installedLanguages(): Promise<string[]> {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return []
  try {
    const { stdout } = await promisify(execFile)(helperPath(), ['--list-languages'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 32768,
    })
    return Intl.getCanonicalLocales(stdout.trim().split(/\s+/).filter(Boolean))
  } catch {
    return []
  }
}
function convert(
  input: string,
  target: string,
  output: string,
  options: OcrFileOptions,
): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, {
      workerData: {
        input,
        target,
        output,
        options,
        helper: helperPath(),
        resourcesPath: process.resourcesPath,
      },
    })
    worker.once('error', reject)
    let reply: { error?: string; missing?: number[] } | undefined
    worker.once('message', (message) => {
      reply = message
    })
    worker.once('exit', (code) => {
      if (code === 0 && reply?.missing) resolve(reply.missing)
      else reject(new Error(reply?.error ?? 'OCR_ENGINE_FAILED'))
    })
  })
}
export function registerOcrIpc(mainWindow: () => BrowserWindow | null, language: () => Lang) {
  const sessions = new WeakMap<WebContents, FileConversionSession>()
  function owner(event: IpcMainInvokeEvent) {
    const win = mainWindow()
    if (
      !win ||
      win.isDestroyed() ||
      event.sender !== win.webContents ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error('OCR requires the main window.')
    return win
  }
  ipcMain.handle(channels.languages, (event) => {
    owner(event)
    return installedLanguages()
  })
  function addInputs(sender: WebContents, paths: string[]) {
    const session = sessions.get(sender) ?? new FileConversionSession(ocrTargets, ' OCR')
    sessions.set(sender, session)
    return session.pick(paths)
  }
  ipcMain.handle(channels.drop, (event, paths: unknown) => {
    owner(event)
    if (!Array.isArray(paths)) throw new Error('Invalid OCR files.')
    return addInputs(
      event.sender,
      paths.filter(
        (p): p is string => typeof p === 'string' && isAbsolute(p) && ocrTargets(p).length > 0,
      ),
    )
  })
  ipcMain.handle(channels.pick, async (event) => {
    const win = owner(event)
    const picked = await showOpenDialogWithMemory(dialog, win, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'PDF · PNG · JPEG', extensions: OCR_EXTENSIONS }],
    })
    if (picked.canceled || win.isDestroyed()) return []
    return addInputs(event.sender, picked.filePaths)
  })
  ipcMain.handle(
    channels.run,
    (event, ids: unknown, target: unknown, options: OcrFileOptions = {}) => {
      const win = owner(event)
      const session = sessions.get(event.sender)
      if (!session) throw new Error('Choose files first.')
      if (
        !options ||
        typeof options !== 'object' ||
        (options.pageRange !== undefined && typeof options.pageRange !== 'string')
      )
        throw new Error('Invalid OCR options.')
      // Query once per batch in case an OS language pack changed after opening the screen.
      const languages = options.language ? installedLanguages() : undefined
      return session.run(
        ids,
        target,
        async (input, format, output) => {
          if (languages && !(await languages).includes(options.language!))
            throw new Error('OCR_LANGUAGE_UNAVAILABLE')
          const pages = await convert(input, format, output, options)
          if (pages.length) return pdfPageWarning(language(), 'pdf_image_pages', pages)
        },
        (result) => event.sender.send(channels.progress, result),
        () => !win.isDestroyed() && !event.sender.isDestroyed(),
      )
    },
  )
}
