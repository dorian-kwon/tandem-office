import { constants, statSync } from 'node:fs'
import { copyFile, link, lstat, mkdtemp, realpath, rm } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { dialog, type BrowserWindow, type MessageBoxOptions } from 'electron'
import { showSaveDialogWithMemory } from '@genoffice/electron-utils'
import type { Lang } from '@genoffice/i18n'
import { createImageCopyProgress } from './progress-window'
import {
  fileIdentity,
  imageDocumentKind,
  MAX_SOURCE_BYTES,
  PROMPT_BMP_BYTES,
  type ImageDocumentKind,
} from './protocol'
import { runImageJob } from './runner'
import { imageCopyText } from './strings'

interface OpenHost {
  parent(): BrowserWindow | null
  lang(): Lang
  isOpen(path: string): boolean
  open(path: string): boolean
}

const pending = new Map<string, AbortController>()
let queue = Promise.resolve()
let fileWork: Promise<unknown> | undefined

/** Before quitting, wait for any worker and file operations that can still use a spool. */
export function cancelDocumentImageOpens(): Promise<unknown> | undefined {
  for (const controller of pending.values()) controller.abort()
  return fileWork
}

async function withFileWork<T>(work: () => Promise<T>): Promise<T> {
  const task = work()
  fileWork = task
  try {
    return await task
  } finally {
    fileWork = undefined
  }
}

/** Accept only explicit opens. Internal recovery and callers needing a tab synchronously use the router. */
export function queueDocumentImageOpen(path: string, host: OpenHost): boolean {
  const kind = imageDocumentKind(path)
  if (!kind) return false
  let key: string
  try {
    const stat = statSync(path, { throwIfNoEntry: false })
    if (!stat?.isFile() || stat.size < PROMPT_BMP_BYTES || stat.size > MAX_SOURCE_BYTES)
      return false
    key = stat.ino ? `${stat.dev}:${stat.ino}` : path
  } catch {
    return false
  }
  if (host.isOpen(path)) return false
  if (pending.has(key)) return true
  const owner = host.parent()
  const controller = new AbortController()
  const cancel = () => controller.abort()
  pending.set(key, controller)
  queue = queue
    .then(async () => {
      if (controller.signal.aborted || owner?.isDestroyed()) return
      owner?.once('closed', cancel)
      if (host.isOpen(path)) {
        host.open(path)
        return
      }
      const result = await imageCopyChoice(path, kind, host.lang(), owner, controller)
      if (result && !controller.signal.aborted) host.open(result)
    })
    .catch(() => {
      // A window can close while its native dialog is pending.
    })
    .finally(() => {
      pending.delete(key)
      owner?.removeListener('closed', cancel)
    })
  return true
}

function message(owner: BrowserWindow | null, options: MessageBoxOptions) {
  return owner && !owner.isDestroyed()
    ? dialog.showMessageBox(owner, options)
    : dialog.showMessageBox(options)
}

async function statIfPresent(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return undefined
  }
}

async function imageCopyChoice(
  path: string,
  kind: ImageDocumentKind,
  lang: Lang,
  owner: BrowserWindow | null,
  controller: AbortController,
): Promise<string | null> {
  const { signal } = controller
  const t = (key: Parameters<typeof imageCopyText>[1], params?: Record<string, string | number>) =>
    imageCopyText(lang, key, params)
  const size = (bytes: number) => Number((bytes / 1024 ** 2).toFixed(1)).toLocaleString(lang)
  const title = t('title')
  let source: string
  let before: number
  let summary
  try {
    source = await realpath(path)
    before = (await lstat(source)).size
    summary = await withFileWork(async () => {
      const { value, dispose } = await runImageJob({ mode: 'inspect', input: source, kind }, signal)
      await dispose()
      return value
    })
  } catch {
    return signal.aborted ? null : path
  }
  if (signal.aborted) return null
  if (!summary || !('bmpBytes' in summary) || summary.bmpBytes < PROMPT_BMP_BYTES) return path
  const buttons = [t('makeCopy'), t('keepOriginal'), t('cancel')]
  const choice = await message(owner, {
    type: 'question',
    title,
    message: t('summary', { count: summary.count, size: size(summary.bmpBytes) }),
    detail: t('detail'),
    buttons,
    defaultId: 1,
    cancelId: 2,
    signal,
  })
  if (signal.aborted || choice.response === 2) return null
  if (choice.response === 1) return path

  const offerOriginal = async (key: 'noSavings' | 'failed'): Promise<string | null> => {
    if (signal.aborted) return null
    const { response } = await message(owner, {
      title,
      type: key === 'failed' ? 'warning' : 'info',
      message: t(key),
      buttons: buttons.slice(1),
      defaultId: 0,
      cancelId: 1,
      signal,
    })
    return response === 0 && !signal.aborted ? path : null
  }

  try {
    const extension = extname(path)
    const picked = await showSaveDialogWithMemory(dialog, owner, {
      title: t('saveTitle'),
      defaultPath: join(dirname(path), `${basename(path, extension)} - JPEG${extension}`),
      filters: [{ name: kind.toUpperCase(), extensions: [kind] }],
      properties: ['createDirectory'],
    })
    if (picked.canceled || !picked.filePath || signal.aborted) return null
    const target = picked.filePath
    if (imageDocumentKind(target) !== kind) return offerOriginal('failed')
    // Reject existing files, including aliases and dangling symlinks. Publication checks again.
    if (await statIfPresent(target)) return offerOriginal('failed')

    const notice = await withFileWork(async (): Promise<MessageBoxOptions | null> => {
      const progress = createImageCopyProgress(owner, lang, () => controller.abort())
      let output: Awaited<ReturnType<typeof runImageJob>> | undefined
      try {
        output = await runImageJob(
          { mode: 'convert', input: source, kind, identity: summary.identity },
          signal,
          progress.update,
        )
        const result = output.value
        const temp = join(output.directory, 'output')
        const after = (await statIfPresent(temp))?.size ?? 0
        if (
          !result ||
          !('converted' in result) ||
          !result.converted ||
          after <= 0 ||
          after >= before
        ) {
          return null
        }
        await publishCopy(temp, target, async () => {
          signal.throwIfAborted()
          if (
            (await realpath(path)) !== source ||
            fileIdentity(await lstat(source)) !== summary.identity
          ) {
            throw new Error('Source changed')
          }
          signal.throwIfAborted()
          // Closing progress marks the start of the final, exclusive save.
          progress.close()
        })
        return {
          type: 'info',
          title,
          message: t('result', {
            before: size(before),
            after: size(after),
            count: result.converted,
            skipped: result.skipped,
          }),
          signal,
        }
      } finally {
        progress.close()
        await output?.dispose()
      }
    })
    if (!notice) return offerOriginal('noSavings')
    if (!signal.aborted) await message(owner, notice)
    return target
  } catch {
    return offerOriginal('failed')
  }
}

/** Stage on the destination filesystem so a completed copy can be published without replacing files. */
async function publishCopy(
  input: string,
  target: string,
  check: () => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(dirname(target), '.tandem-image-copy-'))
  const staged = join(dir, 'copy')
  try {
    await copyFile(input, staged, constants.COPYFILE_EXCL)
    await check()
    try {
      await link(staged, target)
    } catch (error) {
      // Removable filesystems may not support hard links.
      if (!['ENOTSUP', 'EPERM', 'EOPNOTSUPP'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw error
      await check()
      await copyFile(staged, target, constants.COPYFILE_EXCL)
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
