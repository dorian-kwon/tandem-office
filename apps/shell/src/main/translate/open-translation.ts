import { constants } from 'node:fs'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { verifySource, type SourceEntry } from '@genoffice/translate-project'
import { appForPath } from '../app-routing'
import { TranslateIpcError, type TranslateOpenTranslationResult } from '../../shared/translate-api'

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
function plainFileName(file: string): boolean {
  return (
    file !== '' && file !== '.' && file !== '..' && basename(file) === file && !/[\\/]/.test(file)
  )
}

/**
 * Open the translation view for one editable source: the copy in `source/`
 * read-only on the left and `output/<same name>` editable on the right. The
 * output copy is made from the source copy the first time only; an existing
 * output file is the person's work and is always reused, never overwritten.
 *
 * The person's original file is never opened here: `source/` holds a copy made
 * when the source was added. Its hash is checked first: a missing copy is
 * refused, a changed one still opens and reports 'changed' so the screen can
 * warn. PDF, scan and image sources are refused (a later step opens them).
 */
export async function openTranslation(
  dir: string,
  source: SourceEntry,
  deps: TranslationViewDeps,
): Promise<TranslateOpenTranslationResult> {
  if (source.kind !== 'editable')
    throw new TranslateIpcError(
      'SOURCE_NOT_EDITABLE',
      'PDF, scanned and image sources do not open in the translation view yet',
    )
  if (!plainFileName(source.file))
    throw new TranslateIpcError('INVALID_ARGUMENT', 'the source file name is not valid')
  if (!appForPath(source.file))
    throw new TranslateIpcError('UNSUPPORTED_SOURCE', `no editor opens ${source.file}`)

  const sourcePath = join(dir, 'source', source.file)
  const hashStatus = await verifySource(dir, source)
  if (hashStatus === 'missing')
    throw new TranslateIpcError('SOURCE_MISSING', 'the copy in the source folder is missing')

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
  return { sourceTabId, outputTabId, hashStatus }
}
