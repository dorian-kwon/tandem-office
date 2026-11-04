import { constants } from 'node:fs'
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import {
  IMAGE_SOURCE_EXTENSIONS,
  verifySource,
  type OcrMode,
  type SourceEntry,
} from '@genoffice/translate-project'
import { appForPath } from '../app-routing'
import { pdfTranslationTargetOf } from '../../shared/translate-pdf'
import { supportsEmbeddedOcr } from './embedded-images'
import {
  TranslateIpcError,
  type TranslateOpenResultAnswer,
  type TranslateOpenTranslationResult,
} from '../../shared/translate-api'

/** What the translation view needs from the shell's tab manager (index.ts wires it). */
export interface TranslationViewDeps {
  /** open (or focus) the file's editor tab without touching Recent; the tab's
   *  id and whether this call made the tab, or undefined when it did not land
   *  in the main window's strip */
  openTab(path: string): { tabId: string; created: boolean } | undefined
  /** close a tab this view opened, with no save prompt */
  closeTab(tabId: string): void
  /** make the tab read-only (TabManager.setTabReadOnly) */
  setTabReadOnly(tabId: string): boolean
  /** show the two tabs side by side, source on the left, output focused */
  showSplit(sourceTabId: string, outputTabId: string): void
  /** the hide toggle (TabManager.setPaneHidden); false when no translation split is shown */
  setPaneHidden(side: 'left' | 'right', hidden: boolean): boolean
}

/** a stored source name is a plain file name inside source/ (project.json can be edited by hand) */
export function plainFileName(file: string): boolean {
  return (
    file !== '' && file !== '.' && file !== '..' && basename(file) === file && !/[\\/]/.test(file)
  )
}

/** what of the project the routing reads: its OCR choice and target language */
export interface ProjectContext {
  /** absent: off (a scan or image is refused) */
  ocr?: OcrMode
  /** the project's target language code; earlier PDF results are looked for in it */
  targetLang?: string
}

/** the image types the OCR reads: the project's image sources (PNG, JPEG) */
const OCR_IMAGE_EXTENSIONS = IMAGE_SOURCE_EXTENSIONS.map((ext) => `.${ext}`)

function stemOf(file: string): string {
  const ext = extname(file)
  return file.slice(0, file.length - ext.length) || file
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Is `output` a result of `source` (by name): the OCR's Word document, or
 * the translated PDF (plain or bilingual) into the project's current target
 * language `targetLang` (a project language code).
 */
export function isResultOf(source: SourceEntry, output: string, targetLang: string): boolean {
  const stem = escape(stemOf(source.file))
  // the names non-editable.ts and ocr.ts give, with the " (2)" of a taken name
  if (source.kind === 'pdf') {
    const lang = pdfTranslationTargetOf(targetLang)
    if (!lang) return false
    return new RegExp(`^${stem}\\.${escape(lang)}(\\.bilingual)?( \\(\\d+\\))?\\.pdf$`).test(output)
  }
  if (source.kind === 'scan' || source.kind === 'image')
    return new RegExp(`^${stem} \\(OCR\\)( \\(\\d+\\))?\\.docx$`).test(output)
  if (source.kind === 'editable' && supportsEmbeddedOcr(source.file))
    return new RegExp(`^${stem} \\(OCR\\)( \\(\\d+\\))?${escape(extname(source.file))}$`, 'i').test(
      output,
    )
  return false
}

/** the newest earlier result of `source` in output/ (for the current target language), or null */
export async function latestResult(
  dir: string,
  source: SourceEntry,
  targetLang: string,
): Promise<string | null> {
  const outputDir = join(dir, 'output')
  const names = await readdir(outputDir).catch(() => [] as string[])
  let best: { name: string; at: number } | null = null
  for (const name of names) {
    if (name.startsWith('.') || !isResultOf(source, name, targetLang)) continue
    const info = await stat(join(outputDir, name)).catch(() => null)
    if (!info?.isFile()) continue
    if (!best || info.mtimeMs > best.at) best = { name, at: info.mtimeMs }
  }
  return best?.name ?? null
}

/**
 * Open the translation view for one source. An editable document opens at
 * once: the copy in `source/` read-only on the left and `output/<same name>`
 * editable on the right. The output copy is made from the source copy the
 * first time only; an existing output file is the person's work and is
 * always reused, never overwritten.
 *
 * The other kinds open nothing here; the answer tells the screen which flow
 * to run first (main/translate/non-editable.ts):
 * - 'pdf' (a text layer): the translation job, then `openTranslationResult`;
 * - 'scan' and 'image': the OCR window, then `openTranslationResult` with
 *   its Word document. With the project's OCR switched off they are refused
 *   (OCR_DISABLED) instead of producing an empty document.
 * `source.kind` must already be the resolved one (a PDF checked for a scan).
 *
 * The person's original file is never opened here: `source/` holds a copy
 * made when the source was added. Its hash is checked first: a missing copy
 * is refused, a changed one still opens and reports 'changed' so the screen
 * can warn.
 */
export async function openTranslation(
  dir: string,
  source: SourceEntry,
  deps: TranslationViewDeps,
  project: ProjectContext = {},
): Promise<TranslateOpenTranslationResult> {
  const ocr = project.ocr ?? { kind: 'off' }
  const targetLang = project.targetLang ?? ''
  if (!plainFileName(source.file))
    throw new TranslateIpcError('INVALID_ARGUMENT', 'the source file name is not valid')
  if (source.kind === 'scan' || source.kind === 'image') {
    if (ocr.kind !== 'ai')
      throw new TranslateIpcError(
        'OCR_DISABLED',
        'this source is read by OCR first, and OCR is switched off for this project',
      )
    if (
      source.kind === 'image' &&
      !OCR_IMAGE_EXTENSIONS.includes(extname(source.file).toLowerCase())
    )
      throw new TranslateIpcError('UNSUPPORTED_SOURCE', 'only PNG and JPEG images can be read')
  }
  if (source.kind === 'editable' && !appForPath(source.file))
    throw new TranslateIpcError('UNSUPPORTED_SOURCE', `no editor opens ${source.file}`)

  const sourcePath = join(dir, 'source', source.file)
  const hashStatus = await verifySource(dir, source)
  if (hashStatus === 'missing')
    throw new TranslateIpcError('SOURCE_MISSING', 'the copy in the source folder is missing')

  if (source.kind === 'pdf')
    return {
      flow: 'translate-pdf',
      file: source.file,
      hashStatus,
      existing: await latestResult(dir, source, targetLang),
    }
  if (source.kind === 'scan' || source.kind === 'image')
    return {
      flow: 'ocr',
      kind: source.kind,
      file: source.file,
      hashStatus,
      existing: await latestResult(dir, source, targetLang),
    }

  const outputDir = join(dir, 'output')
  const outputPath = join(outputDir, source.file)
  await mkdir(outputDir, { recursive: true })
  try {
    // COPYFILE_EXCL: an existing output copy (the person's edits) is kept as is
    await copyFile(sourcePath, outputPath, constants.COPYFILE_EXCL)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
  // something else under that name (a folder) is not the person's output copy
  if (!(await stat(outputPath)).isFile())
    throw new TranslateIpcError('OPEN_FAILED', 'the output path is not a file')

  const { sourceTabId, outputTabId } = await openPair(sourcePath, outputPath, deps)
  return { flow: 'edit', sourceTabId, outputTabId, hashStatus }
}

/** the source copy read-only on the left, `outputPath` on the right, output focused */
async function openPair(
  sourcePath: string,
  outputPath: string,
  deps: TranslationViewDeps,
): Promise<{ sourceTabId: string; outputTabId: string }> {
  const sourceTab = deps.openTab(sourcePath)
  if (sourceTab === undefined || !deps.setTabReadOnly(sourceTab.tabId))
    throw new TranslateIpcError('OPEN_FAILED', 'the source document could not be opened')
  const sourceTabId = sourceTab.tabId
  const outputTab = deps.openTab(outputPath)
  if (outputTab === undefined) {
    // leave no read-only source tab behind that this call itself opened
    if (sourceTab.created) deps.closeTab(sourceTabId)
    throw new TranslateIpcError('OPEN_FAILED', 'the output document could not be opened')
  }
  const outputTabId = outputTab.tabId
  deps.showSplit(sourceTabId, outputTabId)
  return { sourceTabId, outputTabId }
}

/**
 * Open a result of a PDF, scan or image source (the translated PDF, or the
 * OCR's Word document) beside the source copy: the source read-only on the
 * left, the result editable on the right. An image has no editor to show it,
 * so its Word document opens alone. `output` must be a plain name in
 * output/ that is a result of this source by name (`<stem>.<lang>….pdf` for
 * a PDF, `<stem> (OCR)….docx` for a scan or an image), and an existing file.
 */
export async function openTranslationResult(
  dir: string,
  source: SourceEntry,
  output: unknown,
  deps: TranslationViewDeps,
  targetLang = '',
): Promise<TranslateOpenResultAnswer> {
  if (!plainFileName(source.file))
    throw new TranslateIpcError('INVALID_ARGUMENT', 'the source file name is not valid')
  if (
    typeof output !== 'string' ||
    !plainFileName(output) ||
    !isResultOf(source, output, targetLang)
  )
    throw new TranslateIpcError('INVALID_ARGUMENT', 'this is not a result of that source')
  const outputPath = join(dir, 'output', output)
  const info = await stat(outputPath).catch(() => null)
  if (!info?.isFile())
    throw new TranslateIpcError('OPEN_FAILED', 'the result is not in the output folder')
  if (source.kind === 'image') {
    const tab = deps.openTab(outputPath)
    if (tab === undefined)
      throw new TranslateIpcError('OPEN_FAILED', 'the output document could not be opened')
    return { sourceTabId: null, outputTabId: tab.tabId }
  }
  const sourcePath = join(dir, 'source', source.file)
  if ((await verifySource(dir, source)) === 'missing')
    throw new TranslateIpcError('SOURCE_MISSING', 'the copy in the source folder is missing')
  return openPair(sourcePath, outputPath, deps)
}
