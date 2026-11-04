import { copyFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, isAbsolute } from 'node:path'
import type { SourceEntry } from '@genoffice/translate-project'
import { TranslateIpcError, type TranslateExportResult } from '../../shared/translate-api'
import { isResultOf, latestResult, plainFileName } from './open-translation'

export interface ExportTranslationDeps {
  /** the native save dialog (its own overwrite confirmation included) */
  showSaveDialog(options: {
    defaultPath: string
    filters: { name: string; extensions: string[] }[]
  }): Promise<{ canceled: boolean; filePath?: string | undefined }>
  /** whether the editor showing this file has unsaved changes; absent: not known, treated as saved */
  isDirty?: (path: string) => Promise<boolean>
  /** the folder offered when the project folder cannot be used */
  documentsDir: () => string
}

function stemOf(file: string): string {
  const ext = extname(file)
  return file.slice(0, file.length - ext.length) || file
}

/** the resolved spelling of `path`, following links where the path exists (parent folder at least) */
async function settled(path: string): Promise<string> {
  const full = resolve(path)
  try {
    return await realpath(full)
  } catch {
    try {
      return join(await realpath(dirname(full)), basename(full))
    } catch {
      return full
    }
  }
}

const fold = (path: string): string =>
  process.platform === 'win32' || process.platform === 'darwin' ? path.toLowerCase() : path

function isInside(parent: string, child: string): boolean {
  const rel = relative(fold(parent), fold(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** the plain name in output/ to export: the editable copy, or the newest result of a PDF/scan/image */
async function outputNameOf(
  dir: string,
  source: SourceEntry,
  output: string | undefined,
  targetLang: string,
): Promise<string> {
  let name: string | null
  if (output !== undefined) {
    if (!plainFileName(output) || (output !== source.file && !isResultOf(source, output, targetLang)))
      throw new TranslateIpcError('INVALID_ARGUMENT', 'this is not a result of that source')
    name = output
  } else if (source.kind === 'editable') {
    name = source.file
  } else {
    name = await latestResult(dir, source, targetLang)
  }
  const info = name ? await stat(join(dir, 'output', name)).catch(() => null) : null
  if (!name || !info?.isFile())
    throw new TranslateIpcError('OUTPUT_MISSING', 'there is no translated document to export yet')
  return name
}

/**
 * Copy the current saved output of one source to a path the person picks in the native
 * save dialog, in the same format (the bytes are copied, nothing is converted). Never
 * touches `source/`, never writes without the dialog's own confirmation, and refuses to
 * run while the output's editor holds unsaved changes (the file on disk would be stale).
 */
export async function exportTranslation(
  dir: string,
  source: SourceEntry,
  output: string | undefined,
  targetLang: string,
  deps: ExportTranslationDeps,
): Promise<TranslateExportResult> {
  const name = await outputNameOf(dir, source, output, targetLang)
  const outputPath = join(dir, 'output', name)
  if (deps.isDirty && (await deps.isDirty(outputPath))) return { status: 'unsaved' }

  const ext = extname(name)
  const suggested = `${stemOf(source.file)}${targetLang ? ` (${targetLang})` : ''}${ext}`
  const folder = await stat(dir).then(
    (info) => (info.isDirectory() ? dir : deps.documentsDir()),
    () => deps.documentsDir(),
  )
  const answer = await deps.showSaveDialog({
    defaultPath: join(folder, suggested),
    filters: ext ? [{ name: ext.slice(1).toUpperCase(), extensions: [ext.slice(1)] }] : [],
  })
  if (answer.canceled || !answer.filePath) return { status: 'canceled' }

  const target = await settled(answer.filePath)
  if (isInside(await settled(join(dir, 'source')), target))
    throw new TranslateIpcError('EXPORT_REFUSED', 'the source folder is not a place to export to')
  if (fold(target) === fold(await settled(outputPath)))
    throw new TranslateIpcError('EXPORT_REFUSED', 'that is the translated file itself')
  await copyFile(outputPath, answer.filePath)
  return { status: 'saved', path: answer.filePath }
}
