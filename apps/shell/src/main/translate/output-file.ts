import { constants } from 'node:fs'
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { TranslateIpcError } from '../../shared/translate-api'

/** names tried after `<stem><ext>`: `<stem> (2)<ext>` up to this number */
const MAX_SUFFIX = 1000

/** a temporary file name in `dir` that no result ever carries */
export function temporaryPath(dir: string, ext: string): string {
  return join(dir, `.translate-${randomBytes(6).toString('hex')}.tmp${ext}`)
}

/**
 * Give the finished file `tmpPath` (in `dir`) the name `<stem><ext>`, or
 * `<stem> (2)<ext>`, … when that is taken, with an exclusive copy: an
 * existing file is never replaced and a half-written file never carries the
 * final name. The temporary file is removed either way. Answers the plain
 * file name used.
 */
export async function placeNewFile(
  dir: string,
  stem: string,
  ext: string,
  tmpPath: string,
): Promise<string> {
  try {
    for (let n = 1; n <= MAX_SUFFIX; n++) {
      const name = n === 1 ? `${stem}${ext}` : `${stem} (${n})${ext}`
      try {
        await copyFile(tmpPath, join(dir, name), constants.COPYFILE_EXCL)
        return name
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      }
    }
    throw new TranslateIpcError('OPEN_FAILED', 'no free file name in the output folder')
  } finally {
    await rm(tmpPath, { force: true }).catch(() => undefined)
  }
}

/** write `bytes` as a new file named after `stem` in `dir` (placeNewFile); the full path */
export async function writeNewFile(
  dir: string,
  stem: string,
  ext: string,
  bytes: Uint8Array,
): Promise<string> {
  await mkdir(dir, { recursive: true })
  const tmp = temporaryPath(dir, '')
  await writeFile(tmp, bytes, { flag: 'wx' })
  return join(dir, await placeNewFile(dir, stem, ext, tmp))
}
