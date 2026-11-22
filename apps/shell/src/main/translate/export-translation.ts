import { copyFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, isAbsolute, sep } from 'node:path'
import type { SourceEntry } from '@genoffice/translate-project'
import { TranslateIpcError, type TranslateExportResult } from '../../shared/translate-api'
import { CONVERSION_ROUTES } from '@genoffice/cli/conversion-routes'
import { saveConvertedFile } from '../file-conversion'
import { isResultOf, latestResult, plainFileName } from './open-translation'

export interface ExportTranslationDeps {
  /** the native save dialog (its own overwrite confirmation included) */
  showSaveDialog(options: {
    defaultPath: string
    filters: { name: string; extensions: string[] }[]
  }): Promise<{ canceled: boolean; filePath?: string | undefined }>
  /** whether the editor showing this file has unsaved changes; absent: not known, treated as saved */
  isDirty?: (path: string) => Promise<boolean>
  /** macOS' save panel has no separate output format picker */
  chooseFormat?: (formats: string[]) => Promise<string | null>
  convert?: (input: string, format: string, output: string) => Promise<string | void>
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
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
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
    if (
      !plainFileName(output) ||
      (output !== source.file && !isResultOf(source, output, targetLang))
    )
      throw new TranslateIpcError('INVALID_ARGUMENT', 'this is not a result of that source')
    name = output
  } else if (source.kind === 'editable') {
    // Legacy and tab-separated inputs are edited and saved as a separate XLSX.
    const workbookCopy = ['.xls', '.tsv'].includes(extname(source.file).toLowerCase())
    name =
      workbookCopy || source.workingOutput?.targetLang === targetLang
        ? ((await latestResult(dir, source, targetLang)) ?? source.file)
        : source.file
  } else {
    name = await latestResult(dir, source, targetLang)
  }
  const info = name ? await stat(join(dir, 'output', name)).catch(() => null) : null
  if (!name || !info?.isFile())
    throw new TranslateIpcError('OUTPUT_MISSING', 'there is no translated document to export yet')
  return name
}

/**
 * Export the current saved output to the name and format chosen in the native save dialog. Never
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

  const sourceFormat = extname(name).slice(1).toLowerCase()
  const formats = [
    sourceFormat,
    ...(deps.convert && Object.hasOwn(CONVERSION_ROUTES, sourceFormat)
      ? CONVERSION_ROUTES[sourceFormat]!
      : []),
  ]
  const chosen =
    formats.length > 1 && deps.chooseFormat ? await deps.chooseFormat(formats) : sourceFormat
  if (chosen === null) return { status: 'canceled' }
  if (!formats.includes(chosen))
    throw new TranslateIpcError('EXPORT_REFUSED', 'unsupported output format')
  const suggested = `${stemOf(source.file)}${targetLang ? ` (${targetLang})` : ''}${chosen ? '.' + chosen : ''}`
  const folder = await stat(dir).then(
    (info) => (info.isDirectory() ? dir : deps.documentsDir()),
    () => deps.documentsDir(),
  )
  const answer = await deps.showSaveDialog({
    defaultPath: join(folder, suggested),
    filters: (deps.chooseFormat ? [chosen] : formats)
      .filter(Boolean)
      .map((format) => ({ name: format.toUpperCase(), extensions: [format] })),
  })
  if (answer.canceled || !answer.filePath) return { status: 'canceled' }

  const target = await settled(answer.filePath)
  if (isInside(await settled(join(dir, 'source')), target))
    throw new TranslateIpcError('EXPORT_REFUSED', 'the source folder is not a place to export to')
  if (isInside(await settled(join(dir, 'output')), target))
    throw new TranslateIpcError(
      'EXPORT_REFUSED',
      'the output folder holds the working translations',
    )
  const targetFormat = extname(answer.filePath).slice(1).toLowerCase()
  if (!formats.includes(targetFormat))
    throw new TranslateIpcError('EXPORT_REFUSED', 'unsupported output format')
  if (deps.isDirty && (await deps.isDirty(outputPath))) return { status: 'unsaved' }
  const saved = await saveConvertedFile(
    outputPath,
    targetFormat,
    targetFormat === sourceFormat
      ? (input, _format, staged) => copyFile(input, staged)
      : deps.convert!,
    answer.filePath,
  )
  return {
    status: 'saved',
    path: answer.filePath,
    ...(saved.warning ? { warning: saved.warning } : {}),
  }
}
