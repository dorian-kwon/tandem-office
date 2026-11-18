import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app, nativeImage, utilityProcess } from 'electron'
import { jpegSize } from '../../../../../packages/pptx-render/src/image-dpi'
import processEntryPath from './image-process?modulePath'
import { MAX_BMP_PIXELS } from './bmp'
import type { ImageChildMessage, ImageJob, ImageJobResult } from './protocol'

export interface ImageJobOutput {
  value: ImageJobResult | null
  directory: string
  dispose(): Promise<void>
}

async function encodeJpeg(
  directory: string,
  { id, width, height }: Extract<ImageChildMessage, { type: 'encode' }>,
  stopped: () => boolean,
): Promise<void> {
  const input = join(directory, `${id}.bgra`)
  const stat = await lstat(input)
  if (!stat.isFile() || stat.size !== width * height * 4) throw new Error('Invalid bitmap')
  const bytes = await readFile(input)
  if (stopped()) return
  const bitmap = nativeImage.createFromBitmap(bytes, { width, height, scaleFactor: 1 })
  if (bitmap.isEmpty()) throw new Error('Invalid bitmap')
  const jpeg = bitmap.toJPEG(90)
  const dimensions = jpegSize(jpeg)
  if (dimensions?.w !== width || dimensions.h !== height) throw new Error('Invalid JPEG')
  await writeFile(join(directory, `${id}.jpg`), jpeg, { flag: 'wx', mode: 0o600 })
}

/** The caller owns the returned private directory until the new copy is published. */
export async function runImageJob(
  job: Omit<ImageJob, 'type' | 'directory'>,
  signal: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<ImageJobOutput> {
  signal.throwIfAborted()
  const directory = await mkdtemp(join(tmpdir(), 'tandem-image-copy-'))
  const dispose = () => rm(directory, { recursive: true, force: true })
  try {
    signal.throwIfAborted()
    const value = await new Promise<ImageJobResult | null>((resolve, reject) => {
      const child = utilityProcess.fork(processEntryPath, [], {
        serviceName: 'document-image-copy',
      })
      let settled = false
      let encoding: Promise<void> | undefined
      let lastImage = 0
      const exited = new Promise<void>((done) => child.once('exit', () => done()))
      const stop = (error?: Error, result?: ImageJobResult | null) => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        clearInterval(memory)
        signal.removeEventListener('abort', cancel)
        child.kill()
        // Neither process may still be using the spool when the caller removes it.
        void Promise.allSettled([exited, encoding]).then(() => {
          if (error) reject(error)
          else resolve(result ?? null)
        })
      }
      const cancel = () => stop(new Error('Image copy cancelled'))
      const deadline = setTimeout(
        () => stop(new Error('Image copy timed out')),
        job.mode === 'inspect' ? 30_000 : 10 * 60_000,
      )
      const memory = setInterval(() => {
        const usage = app.getAppMetrics().find((entry) => entry.pid === child.pid)
        const { total, available, free } = process.getSystemMemoryInfo()
        const workingSetLimit = total > 0 ? Math.min(6 * 1024 ** 2, total / 3) : 6 * 1024 ** 2
        // macOS can report very few untouched pages even with reclaimable memory.
        const allocatable = process.platform === 'linux' ? available : free
        const underPressure =
          process.platform !== 'darwin' && allocatable > 0 && allocatable < 256 * 1024
        if ((usage?.memory.workingSetSize ?? 0) > workingSetLimit || underPressure) {
          stop(new Error('Image copy memory limit'))
        }
      }, 1000)
      signal.addEventListener('abort', cancel, { once: true })
      child.once('error', () => stop(new Error('Image copy process failed')))
      void exited.then(() => stop(new Error('Image copy process exited')))
      child.once('spawn', () => {
        if (!settled) child.postMessage({ ...job, type: 'run', directory })
        else child.kill()
      })
      child.on('message', (message: ImageChildMessage) => {
        if (settled) return
        if (message.type === 'result') stop(undefined, message.value)
        else if (message.type === 'error') stop(new Error('Image copy failed'))
        else if (message.type === 'progress') onProgress?.(message.done, message.total)
        else if (message.type === 'encode') {
          const { id, width, height } = message
          if (
            encoding ||
            job.mode !== 'convert' ||
            id !== lastImage + 1 ||
            !Number.isSafeInteger(width) ||
            !Number.isSafeInteger(height) ||
            width <= 0 ||
            height <= 0 ||
            width * height > MAX_BMP_PIXELS
          ) {
            stop(new Error('Invalid image encoding request'))
            return
          }
          lastImage = id
          encoding = encodeJpeg(directory, message, () => settled)
          void encoding.then(
            () => {
              encoding = undefined
              if (!settled) child.postMessage({ type: 'encoded', id, ok: true })
            },
            () => stop(new Error('Image encoding failed')),
          )
        }
      })
      if (signal.aborted) cancel()
    })
    return { value, directory, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}
