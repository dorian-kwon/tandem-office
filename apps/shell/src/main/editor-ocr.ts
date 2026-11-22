import { constants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, rm } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { saveConvertedFile } from './file-conversion'
import { appForPath } from './app-routing'

export interface EditorOcrChoice {
  format: string
  apply: boolean
}

export function editorOcrFormats(path: string): string[] {
  const ext = extname(path).slice(1).toLowerCase()
  if (!appForPath(path)) return []
  if (ext === 'pdf' || ext === 'pptx') return ['pdf', 'docx']
  if (ext === 'xls' || ext === 'xlsx' || ext === 'xlsm')
    return [ext === 'xlsm' ? ext : 'xlsx', 'docx', 'pdf']
  return ['docx', 'pdf']
}
export function canApplyEditorOcr(path: string, readOnly: boolean, target: string): boolean {
  return (
    !readOnly &&
    extname(path).toLowerCase() === '.' + target &&
    ['pdf', 'docx', 'xlsx', 'xlsm'].includes(target)
  )
}

function version(path: string) {
  return lstat(path, { bigint: true }).then((s) => ({
    mode: Number(s.mode & 0o777n),
    separate: s.isFile() && s.nlink === 1n,
    key: [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join('/'),
  }))
}

async function backupOriginal(path: string) {
  const ext = extname(path)
  const stem = basename(path, ext)
  for (let n = 1; ; n++) {
    const backup = join(
      dirname(path),
      stem + ' (before OCR)' + (n === 1 ? '' : ' (' + n + ')') + ext,
    )
    try {
      await copyFile(path, backup, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
      return backup
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}

export async function writeEditorOcr(
  input: string,
  choice: EditorOcrChoice,
  options: {
    readOnly: boolean
    outputDir: string
    /** The same editor is still bound to this path and has no new edits. */
    current: () => Promise<boolean>
    recognize: (input: string, format: string, output: string) => Promise<string | void>
  },
) {
  if (
    !editorOcrFormats(input).includes(choice.format) ||
    (choice.apply && !canApplyEditorOcr(input, options.readOnly, choice.format))
  )
    throw new Error('OCR_UNAVAILABLE')
  const before = await version(input)
  if (choice.apply && !before.separate) throw new Error('OCR_DOCUMENT_CHANGED')
  await mkdir(options.outputDir, { recursive: true })
  if (!(await lstat(options.outputDir)).isDirectory()) throw new Error('OCR_DOCUMENT_CHANGED')
  const unchanged = async () => {
    if (!(await options.current()) || (await version(input)).key !== before.key)
      throw new Error('OCR_DOCUMENT_CHANGED')
  }
  const result = await saveConvertedFile(
    input,
    choice.format,
    async (source, format, staged) => {
      await unchanged()
      const warning = await options.recognize(source, format, staged)
      await unchanged()
      if (choice.apply) {
        await chmod(staged, before.mode)
        const backup = await backupOriginal(input)
        try {
          await unchanged()
        } catch (error) {
          await rm(backup, { force: true })
          throw error
        }
      }
      return warning
    },
    choice.apply ? input : undefined,
    ' (OCR)',
    options.outputDir,
  )
  return result
}
