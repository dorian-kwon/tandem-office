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
import { conversionWarning, pdfPageWarning } from '../shared/conversion-warning'
import { FileConversionSession } from './file-conversion'
import { OCR_EXTENSIONS, ocrTargets } from './ocr-targets'
import { withOcrInput } from './ocr-office-input'
import { cliErrorMessage, type CliRunner } from './mcp/cli-runner'
import type { ExcelOcrDestination } from './ocr-office-workbook'
import workerPath from './ocr-file-worker?modulePath'

function helperPath() {
  const name = process.platform === 'darwin' ? 'vision-ocr' : 'win-ocr.exe'
  return app.isPackaged
    ? join(process.resourcesPath, 'ocr', name)
    : join(app.getAppPath(), '../../packages/pdf2docx/ocr-helper', name)
}
export async function installedOcrLanguages(): Promise<string[]> {
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
function runWorker(data: Record<string, unknown>): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: data })
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
export function withPreparedOcrFile<T>(
  input: string,
  format: string,
  pageRange: string | undefined,
  lang: Lang,
  cli: CliRunner,
  ready: (prepared: string) => Promise<T>,
  warnings: string[] = [],
): Promise<T> {
  return withOcrInput(
    input,
    format,
    pageRange,
    async (source, to, dest) => {
      // The CLI's --headless-export child owns a dialog-free save target.
      const result = await cli.run(['convert', source, '--to', to, '--out', dest], {
        timeoutMs: 600_000,
      })
      if (!result.ok) throw new Error(cliErrorMessage(result))
      if (result.json?.status === 'ok')
        for (const warning of result.json.warnings ?? [])
          warnings.push(conversionWarning(lang, warning))
    },
    async (source, html) => {
      await runWorker({
        task: 'sheetHtml',
        input: source,
        output: html,
        resourcesPath: process.resourcesPath,
      })
    },
    ready,
  )
}
/** Shared native OCR pipeline for batch conversions and the active editor. */
export async function recognizeFile(
  input: string,
  format: string,
  output: string,
  options: OcrFileOptions & {
    plainText?: boolean
    placement?: 'replace' | 'below'
    destination?: ExcelOcrDestination
  },
  lang: Lang,
  cli: CliRunner,
) {
  const warnings: string[] = []
  const pages = await withPreparedOcrFile(
    input,
    format,
    options.pageRange,
    lang,
    cli,
    (prepared) =>
      runWorker({
        input: prepared,
        target: format,
        output,
        options,
        helper: helperPath(),
        resourcesPath: process.resourcesPath,
      }),
    warnings,
  )
  if (pages.length) warnings.push(pdfPageWarning(lang, 'pdf_image_pages', pages))
  return warnings.join(' ') || undefined
}
export function registerOcrIpc(
  mainWindow: () => BrowserWindow | null,
  language: () => Lang,
  cli: () => CliRunner,
  filterLabel: () => string,
) {
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
    return installedOcrLanguages()
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
      filters: [{ name: filterLabel(), extensions: OCR_EXTENSIONS }],
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
      const languages = options.language ? installedOcrLanguages() : undefined
      return session.run(
        ids,
        target,
        async (input, format, output) => {
          if (languages && !(await languages).includes(options.language!))
            throw new Error('OCR_LANGUAGE_UNAVAILABLE')
          return recognizeFile(input, format, output, options, language(), cli())
        },
        (result) => event.sender.send(channels.progress, result),
        () => !win.isDestroyed() && !event.sender.isDestroyed(),
      )
    },
  )
}
