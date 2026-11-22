import { basename, dirname, extname, join } from 'node:path'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import {
  createProject,
  addSource,
  loadProject,
  projectStatus,
  saveProject,
  type OcrMode,
} from '@genoffice/translate-project'
import type { ChatOcrRequest } from '@genoffice/project-store/folder-api'
import { OLD_WORD_MESSAGE, type ChatOcrContext } from './ocr-chat'
const sameName = (a: string, b: string) => a.normalize('NFC') === b.normalize('NFC')

/** Private copies older than this are removed. */
export const OCR_WORK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Remove private OCR project copies under `work` that were last changed more than `maxAgeMs`
 * ago. Only direct subfolders are considered; failures are ignored (a copy in use stays).
 * Returns the number of copies removed.
 */
export async function pruneOcrWorkDir(
  work: string,
  now: number,
  maxAgeMs: number = OCR_WORK_MAX_AGE_MS,
): Promise<number> {
  let removed = 0
  let names: string[]
  try {
    names = await readdir(work)
  } catch {
    return 0
  }
  for (const name of names) {
    const path = join(work, name)
    try {
      const info = await stat(path)
      if (!info.isDirectory() || now - info.mtimeMs <= maxAgeMs) continue
      await rm(path, { recursive: true, force: true })
      removed += 1
    } catch {
      // leave what cannot be inspected or removed
    }
  }
  return removed
}

/** Only main's selected project/current document is accepted; no renderer-supplied paths. */
export function chatOcrSourceResolver(
  workDir: () => string,
  ocrMode: () => OcrMode,
  options: { currentFileOnly?: boolean } = {},
) {
  return async (
    _owner: number,
    input: ChatOcrRequest,
    context: ChatOcrContext,
  ): Promise<{ dir: string; file: string; besideSourceDir?: string } | { files: string[] }> => {
    const given = input.file
    if (
      given !== undefined &&
      (typeof given !== 'string' ||
        basename(given) !== given ||
        /[\\/]/.test(given) ||
        given === '.' ||
        given === '..')
    )
      throw new Error('Choose a listed file name')
    let root = context.projectRoot
    if (!options.currentFileOnly && !root && context.docPath) {
      const parent = dirname(context.docPath)
      if (['source', 'output'].includes(basename(parent))) root = dirname(parent)
    }
    if (!options.currentFileOnly && root && (await projectStatus(root)) === 'ok') {
      const project = await loadProject(root)
      const wanted = given ?? (context.docPath ? basename(context.docPath) : undefined)
      const source = wanted
        ? project.sources.find((s) => sameName(s.file, wanted))
        : project.sources.length === 1
          ? project.sources[0]
          : undefined
      if (!source) {
        if (given) throw new Error('The file is not a source in this project')
        return { files: project.sources.map((s) => s.file) }
      }
      return { dir: root, file: source.file }
    }
    const path = context.docPath
    if (!path || (given && !sameName(basename(path), given)))
      throw new Error('Open the document or select its translation project first')
    if (extname(path).toLowerCase() === '.doc') throw new Error(OLD_WORD_MESSAGE)
    if (!/\.(docx|xlsx|hwpx|hwp|pdf)$/i.test(extname(path)))
      throw new Error('This document format is not supported by embedded OCR')
    const info = await stat(path)
    if (!info.isFile() || info.size > 128 * 1024 * 1024)
      throw new Error('This document is too large for embedded OCR')
    const work = workDir()
    await mkdir(work, { recursive: true })
    await pruneOcrWorkDir(work, Date.now())
    const made = await createProject(work, randomUUID(), 'auto', 'en')
    try {
      const project = await addSource(made.dir, path)
      await saveProject(made.dir, { ...project, ocr: ocrMode() })
      return { dir: made.dir, file: project.sources[0]!.file, besideSourceDir: dirname(path) }
    } catch (error) {
      await rm(made.dir, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }
}
