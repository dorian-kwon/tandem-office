import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, open, rm, type FileHandle } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { SourceEntry, SourceKind } from './project-file'

export class UnsupportedSourceError extends Error {
  constructor(fileName: string) {
    super(`unsupported source file type: ${fileName}`)
    this.name = 'UnsupportedSourceError'
  }
}

/**
 * The document types a source may be: exactly the extensions the app opens in
 * an editor tab (apps/shell/src/main/app-routing.ts), PDF aside. This package
 * cannot import the shell, so the list is kept here and the shell's test
 * `translate-source-types.test.ts` fails when the two differ.
 */
export const EDITABLE_SOURCE_EXTENSIONS: readonly string[] = [
  'docx',
  'odt',
  'xlsx',
  'xlsm',
  'xls',
  'csv',
  'tsv',
  'pptx',
  'md',
  'markdown',
  'txt',
  'json',
  'html',
  'htm',
  'xmind',
  'hwp',
  'hwpx',
  'epub',
]

/** The image types OCR reads (the AI receives PNG or JPEG only). */
export const IMAGE_SOURCE_EXTENSIONS: readonly string[] = ['png', 'jpg', 'jpeg']

/**
 * Classify a source by extension (case-insensitive). Never returns 'scan';
 * scan detection for PDFs happens later.
 */
export function classifySource(fileName: string): SourceKind {
  const ext = extname(fileName).slice(1).toLowerCase()
  if (ext === 'pdf') return 'pdf'
  if (IMAGE_SOURCE_EXTENSIONS.includes(ext)) return 'image'
  if (EDITABLE_SOURCE_EXTENSIONS.includes(ext)) return 'editable'
  throw new UnsupportedSourceError(fileName)
}

/** Whether anything (a file, folder or link) has this path. */
async function taken(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw e
  }
}

/**
 * Copy a file into destDir (created if needed) without overwriting anything.
 * On a name clash the file becomes `name (2).ext`, `name (3).ext`, ...
 * A name that exists in any of `alsoAvoid` (directories that are only looked
 * at, never written; a missing one counts as empty) is skipped too.
 * Returns the final file name. The original is only read.
 */
export async function copyIntoWithSuffix(
  destDir: string,
  originalPath: string,
  alsoAvoid: readonly string[] = [],
  sourceHandle?: FileHandle,
): Promise<string> {
  await mkdir(destDir, { recursive: true })
  const base = basename(originalPath)
  const ext = extname(base)
  const stem = ext ? base.slice(0, -ext.length) : base
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${stem} (${n})${ext}`
    let skip = false
    for (const other of alsoAvoid) if (await taken(join(other, name))) skip = true
    if (skip) continue
    try {
      // COPYFILE_EXCL makes the clash check atomic.
      const destination = join(destDir, name)
      if (sourceHandle) {
        // Copy the file the caller opened and checked, even if it was since renamed.
        const output = await open(destination, 'wx', 0o600)
        try {
          try {
            await output.writeFile(sourceHandle.createReadStream({ autoClose: false }))
          } finally {
            await output.close()
          }
        } catch (error) {
          await rm(destination, { force: true })
          throw error
        }
      } else {
        await copyFile(originalPath, destination, constants.COPYFILE_EXCL)
      }
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

/**
 * Copy an original into `<projectDir>/source/` and record its SHA-256. The
 * name is also kept free in `output/`: removing a source keeps its
 * translation there, and a document added again under the same name must
 * start a fresh output copy instead of inheriting that one.
 */
export async function importSource(projectDir: string, originalPath: string): Promise<SourceEntry> {
  const kind = classifySource(basename(originalPath))
  const dir = join(projectDir, 'source')
  const file = await copyIntoWithSuffix(dir, originalPath, [join(projectDir, 'output')])
  return { file, sha256: await hashFile(join(dir, file)), kind }
}

/**
 * The source copy is gone but the translation in `output/` is there: copy that file into
 * `source/` under the same name (never over an existing file) and return its fresh hash, so
 * the translation can serve as the original. The output file itself is left as it is.
 */
export async function adoptOutputAsSource(projectDir: string, file: string): Promise<string> {
  const from = join(projectDir, 'output', file)
  const to = join(projectDir, 'source', file)
  await mkdir(join(projectDir, 'source'), { recursive: true })
  await copyFile(from, to, constants.COPYFILE_EXCL)
  return hashFile(to)
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
