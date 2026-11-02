import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { constants } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { SourceEntry, SourceKind } from './project-file'

export class UnsupportedSourceError extends Error {
  constructor(fileName: string) {
    super(`unsupported source file type: ${fileName}`)
    this.name = 'UnsupportedSourceError'
  }
}

const EDITABLE = [
  'docx',
  'xlsx',
  'pptx',
  'hwp',
  'hwpx',
  'epub',
  'md',
  'markdown',
  'txt',
  'html',
  'htm',
  'odt',
  'ods',
  'odp',
]
const IMAGES = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'tif', 'tiff', 'webp']

/**
 * Classify a source by extension (case-insensitive). Never returns 'scan';
 * scan detection for PDFs happens later.
 */
export function classifySource(fileName: string): SourceKind {
  const ext = extname(fileName).slice(1).toLowerCase()
  if (ext === 'pdf') return 'pdf'
  if (IMAGES.includes(ext)) return 'image'
  if (EDITABLE.includes(ext)) return 'editable'
  throw new UnsupportedSourceError(fileName)
}

/**
 * Copy a file into destDir (created if needed) without overwriting anything.
 * On a name clash the file becomes `name (2).ext`, `name (3).ext`, ...
 * Returns the final file name. The original is only read.
 */
export async function copyIntoWithSuffix(destDir: string, originalPath: string): Promise<string> {
  await mkdir(destDir, { recursive: true })
  const base = basename(originalPath)
  const ext = extname(base)
  const stem = ext ? base.slice(0, -ext.length) : base
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${stem} (${n})${ext}`
    try {
      // COPYFILE_EXCL makes the clash check atomic.
      await copyFile(originalPath, join(destDir, name), constants.COPYFILE_EXCL)
      return name
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  }
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/** Copy an original into `<projectDir>/source/` and record its SHA-256. */
export async function importSource(projectDir: string, originalPath: string): Promise<SourceEntry> {
  const kind = classifySource(basename(originalPath))
  const dir = join(projectDir, 'source')
  const file = await copyIntoWithSuffix(dir, originalPath)
  return { file, sha256: await hashFile(join(dir, file)), kind }
}

/** Compare the copy in source/ against the recorded hash. */
export async function verifySource(
  projectDir: string,
  entry: SourceEntry,
): Promise<'ok' | 'changed' | 'missing'> {
  try {
    const actual = await hashFile(join(projectDir, 'source', entry.file))
    return actual === entry.sha256 ? 'ok' : 'changed'
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw e
  }
}
