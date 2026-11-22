import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import {
  IMAGE_SOURCE_EXTENSIONS,
  loadProject,
  saveProject,
  verifySource,
  withProjectLock,
  type OcrMode,
  type SourceEntry,
} from '@genoffice/translate-project'
import { appForPath } from '../app-routing'
import { pdfTranslationTargetOf } from '../../shared/translate-pdf'
import { supportsEmbeddedOcr, supportsExtractedOcr } from './embedded-images'
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
  if (
    source.kind === 'scan' ||
    source.kind === 'image' ||
    (source.kind === 'editable' && supportsExtractedOcr(source.file))
  )
    return new RegExp(`^${stem} \\(OCR\\)( \\(\\d+\\))?\\.docx$`).test(output)
  if (source.kind === 'editable' && ['.xls', '.tsv'].includes(extname(source.file).toLowerCase()))
    return new RegExp(`^${escape(source.file)}( \\(\\d+\\))?\\.xlsx$`, 'i').test(output)
  if (source.kind === 'editable' && supportsEmbeddedOcr(source.file))
    return new RegExp(`^${stem} \\(OCR\\)( \\(\\d+\\))?${escape(extname(source.file))}$`, 'i').test(
      output,
    )
  return false
}

/** Prefer the output explicitly opened or previously created for this source. Older
 * projects can recover a unique association from the writer's naming convention. */
export async function latestResult(
  dir: string,
  source: SourceEntry,
  targetLang: string,
  chosen?: { lastOpened?: string; knownOnly: boolean },
): Promise<string | null> {
  const folder = join(dir, 'output')
  const preferred =
    source.workingOutput?.targetLang === targetLang ? source.workingOutput.name : chosen?.lastOpened
  if (chosen?.knownOnly && !preferred) return null
  const entries = (await loadProject(dir)).sources
  const others = entries.filter((e) => e.file !== source.file)
  const reserved = (name: string) =>
    others.some(
      (e) =>
        e.file.normalize('NFC').toLowerCase() === name.normalize('NFC').toLowerCase() ||
        e.workingOutput?.name === name,
    )
  if (
    preferred &&
    plainFileName(preferred) &&
    isResultOf(source, preferred, targetLang) &&
    !reserved(preferred)
  ) {
    const info = await lstat(join(folder, preferred)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (info?.isFile() && info.nlink === 1) return preferred
    if (info)
      throw new TranslateIpcError(
        'OPEN_FAILED',
        'The working output is not a separate regular file.',
      )
  }
  if (chosen?.knownOnly) return null
  const names = await readdir(folder).catch(() => [] as string[])
  let best: { name: string; at: number } | null = null
  for (const name of names) {
    if (
      name.startsWith('.') ||
      !isResultOf(source, name, targetLang) ||
      reserved(name) ||
      others.some((e) => isResultOf(e, name, targetLang))
    )
      continue
    const info = await lstat(join(folder, name)).catch(() => null)
    if (!info?.isFile() || info.nlink !== 1) continue
    if (!best || info.mtimeMs > best.at) best = { name, at: info.mtimeMs }
  }
  return best?.name ?? null
}

export async function rememberWorkingOutput(
  dir: string,
  entry: SourceEntry,
  targetLang: string,
  name: string,
) {
  if (!plainFileName(name) || !isResultOf(entry, name, targetLang)) return
  await withProjectLock(dir, async () => {
    const project = await loadProject(dir)
    const source = project.sources.find((s) => s.file === entry.file && s.sha256 === entry.sha256)
    if (!source || project.targetLang !== targetLang)
      throw new TranslateIpcError('SOURCE_CHANGED', 'The project source or language changed.')
    if (
      project.sources.some(
        (s) =>
          s !== source &&
          (s.file.normalize('NFC').toLowerCase() === name.normalize('NFC').toLowerCase() ||
            s.workingOutput?.name === name),
      )
    )
      throw new TranslateIpcError('OPEN_FAILED', 'This output belongs to another source.')
    if (source.workingOutput?.name === name && source.workingOutput.targetLang === targetLang)
      return
    source.workingOutput = { name, targetLang }
    await saveProject(dir, project)
  })
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
  if (hashStatus === 'missing') {
    // only the translation is left: offer to use it as the original instead of failing
    const outputInfo =
      source.kind === 'editable'
        ? await stat(join(dir, 'output', source.file)).catch(() => null)
        : null
    if (outputInfo?.isFile()) return { flow: 'source-missing', file: source.file }
    throw new TranslateIpcError('SOURCE_MISSING', 'the copy in the source folder is missing')
  }

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

  if (
    source.workingOutput?.targetLang === targetLang ||
    ['.xls', '.tsv'].includes(extname(source.file).toLowerCase())
  ) {
    const workbook = await latestResult(dir, source, targetLang)
    if (workbook) {
      const outputPath = join(dir, 'output', workbook)
      const info = await lstat(outputPath)
      if (!(await lstat(join(dir, 'output'))).isDirectory() || !info.isFile() || info.nlink > 1)
        throw new TranslateIpcError('OPEN_FAILED', 'The result is not a separate project file.')
      const tabs = await openPair(sourcePath, outputPath, deps)
      return { flow: 'edit', ...tabs, hashStatus, output: workbook }
    }
  }
  const outputPath = await prepareTranslationCopy(dir, source.file)
  const { sourceTabId, outputTabId } = await openPair(sourcePath, outputPath, deps)
  return { flow: 'edit', sourceTabId, outputTabId, hashStatus }
}

/** Prepare the same editable output for the split view, batch worker and project chat. */
export async function prepareTranslationCopy(dir: string, file: string): Promise<string> {
  if (!plainFileName(file))
    throw new TranslateIpcError('INVALID_ARGUMENT', 'invalid source file name')
  return withProjectLock(dir, async () => {
    const sourceDir = join(dir, 'source')
    const outputDir = join(dir, 'output')
    const source = join(sourceDir, file)
    const output = join(outputDir, file)
    await mkdir(outputDir, { recursive: true })
    if (
      !(await lstat(sourceDir)).isDirectory() ||
      !(await lstat(outputDir)).isDirectory() ||
      !(await lstat(source)).isFile()
    )
      throw new TranslateIpcError(
        'OPEN_FAILED',
        'the project source or output is not a local project file',
      )
    try {
      await copyFile(source, output, constants.COPYFILE_EXCL)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    const info = await lstat(output)
    if (!info.isFile() || info.nlink > 1)
      throw new TranslateIpcError('OPEN_FAILED', 'the output is not a separate regular file')
    return output
  })
}

/** the source copy read-only on the left, `outputPath` on the right, output focused */
export async function openPair(
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
