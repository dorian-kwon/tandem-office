import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { imagesToPdfBytes } from '../../../../pdf/src/main/images-to-pdf'
import { temporaryPath } from './output-file'

/** Image files have no editor tab. Show the source pixels in the read-only PDF pane. */
export async function previewBatchSourceImage(source: string, tempDir: string): Promise<string> {
  const image = await readFile(source)
  const fingerprint = createHash('sha256').update(image).digest('hex')
  const dir = join(tempDir, 'tandem-office-source-preview', fingerprint)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const preview = join(dir, basename(source) + '.pdf')
  if ((await stat(preview).catch(() => null))?.isFile()) return preview
  const staged = temporaryPath(dir, '.pdf')
  try {
    await writeFile(staged, await imagesToPdfBytes([image], { paper: null, marginPt: 0 }), {
      flag: 'wx',
    })
    await rename(staged, preview)
    return preview
  } finally {
    await rm(staged, { force: true })
  }
}
