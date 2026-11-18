/** One bounded job per utility process; large pixel buffers stay on local disk. */
import { constants, createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, open, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inspectHwpBmp, optimizeHwpBmp } from '../../../../hwp/src/main/embedded-bmp'
import { decodeBmpForJpeg } from './bmp'
import { inspectZipBmp, optimizeZipBmp } from './zip'
import { fileIdentity, MAX_SOURCE_BYTES, type ImageChildMessage, type ImageJob } from './protocol'

interface ParentPort {
  on(
    event: 'message',
    listener: (event: { data: ImageJob | { type: 'encoded'; id: number; ok: boolean } }) => void,
  ): void
  postMessage(message: ImageChildMessage): void
}
const port = (process as unknown as { parentPort?: ParentPort }).parentPort
const pending = new Map<number, (ok: boolean) => void>()
let started = false
async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
/** Read only the checked extent, even if another process grows or replaces the file. */
async function readHwp(path: string, size: number, identity: string): Promise<Buffer> {
  const input = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    if (fileIdentity(await input.stat()) !== identity) throw new Error('Source changed')
    const bytes = Buffer.allocUnsafe(size)
    let offset = 0
    while (offset < size) {
      const { bytesRead } = await input.read(
        bytes,
        offset,
        Math.min(size - offset, 8 * 1024 ** 2),
        offset,
      )
      if (!bytesRead) throw new Error('Source changed')
      offset += bytesRead
    }
    return bytes
  } finally {
    await input.close()
  }
}

async function run(job: ImageJob): Promise<void> {
  const stat = await lstat(job.input)
  if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) throw new Error('Unsupported source')
  const identity = fileIdentity(stat)
  if (job.identity && identity !== job.identity) throw new Error('Source changed')
  const hwp = job.kind === 'hwp' ? await readHwp(job.input, stat.size, identity) : null
  const zipKind = job.kind as Exclude<ImageJob['kind'], 'hwp'>
  if (job.mode === 'inspect') {
    const found = hwp ? inspectHwpBmp(hwp) : await inspectZipBmp(job.input, zipKind)
    if (identity !== fileIdentity(await lstat(job.input))) throw new Error('Source changed')
    port!.postMessage({ type: 'result', value: found ? { ...found, identity } : null })
    return
  }

  const originalHash = hwp
    ? createHash('sha256').update(hwp).digest('hex')
    : await hashFile(job.input)
  let serial = 0
  const encode = async (bmp: Buffer): Promise<Buffer | null> => {
    const decoded = decodeBmpForJpeg(bmp)
    if (!decoded) return null
    const id = ++serial
    const bitmapPath = join(job.directory, `${id}.bgra`)
    const jpegPath = join(job.directory, `${id}.jpg`)
    try {
      await writeFile(bitmapPath, decoded.bgra, { flag: 'wx', mode: 0o600 })
      const accepted = new Promise<boolean>((resolve) => pending.set(id, resolve))
      port!.postMessage({ type: 'encode', id, width: decoded.width, height: decoded.height })
      if (!(await accepted)) throw new Error('Image encoding failed')
      return await readFile(jpegPath)
    } finally {
      await Promise.all([rm(bitmapPath, { force: true }), rm(jpegPath, { force: true })])
    }
  }
  const options = {
    onProgress: (done: number, total: number) =>
      port!.postMessage({ type: 'progress', done, total }),
  }
  const output = join(job.directory, 'output')
  let result: { converted: number; skipped: number }
  if (hwp) {
    const { bytes, converted, skipped } = await optimizeHwpBmp(hwp, encode, options)
    if (converted) await writeFile(output, bytes, { flag: 'wx', mode: 0o600 })
    result = { converted, skipped }
  } else {
    result = await optimizeZipBmp(job.input, output, zipKind, encode, options)
  }
  if (
    originalHash !== (await hashFile(job.input)) ||
    identity !== fileIdentity(await lstat(job.input))
  ) {
    throw new Error('Source changed')
  }
  port!.postMessage({ type: 'result', value: result })
}
port?.on('message', ({ data }) => {
  if (data.type === 'encoded') {
    pending.get(data.id)?.(data.ok)
    pending.delete(data.id)
  } else if (data.type === 'run' && !started) {
    started = true
    void run(data).catch(() => port.postMessage({ type: 'error' }))
  }
})
