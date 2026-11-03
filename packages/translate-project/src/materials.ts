import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseGlossary, type GlossaryEntry } from './glossary'
import type { ProjectFile } from './project-file'
import { withProjectLock } from './project-lock'
import {
  syncReferenceIndex,
  type ReferenceConverter,
  type ReferenceStatus,
} from './reference-index'
import { loadProject, saveProject } from './project-store'
import { copyIntoWithSuffix, importSource } from './source-guard'

const STATE_DIR = '.tandem'
const GLOSSARY_JSON = 'glossary.json'

export class NotListedError extends Error {
  constructor(file: string) {
    super(`file is not listed in the project: ${JSON.stringify(file)}`)
    this.name = 'NotListedError'
  }
}

/** Reject anything that is not a plain file name, before any file system call. */
function assertPlainName(file: string): void {
  if (file === '' || file === '.' || file === '..' || /[\\/]/.test(file) || file.includes('\0')) {
    throw new NotListedError(file)
  }
}

/** Remove a file, ignoring failures: used only for best-effort cleanup. */
async function removeQuietly(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined)
}

export function addSource(dir: string, originalPath: string): Promise<ProjectFile> {
  return withProjectLock(dir, async () => {
    const project = await loadProject(dir)
    const entry = await importSource(dir, originalPath)
    const next = { ...project, sources: [...project.sources, entry] }
    try {
      await saveProject(dir, next)
    } catch (e) {
      await removeQuietly(join(dir, 'source', entry.file))
      throw e
    }
    return next
  })
}

/** Deletes only the copy in source/. Anything in output/ is left alone. */
export function removeSource(dir: string, file: string): Promise<ProjectFile> {
  return withProjectLock(dir, async () => {
    assertPlainName(file)
    const project = await loadProject(dir)
    if (!project.sources.some((s) => s.file === file)) throw new NotListedError(file)
    const next = { ...project, sources: project.sources.filter((s) => s.file !== file) }
    await saveProject(dir, next)
    await rm(join(dir, 'source', file), { force: true })
    return next
  })
}

export interface ReferenceOptions {
  /**
   * converts a reference file to markdown for the keyword index (the shell
   * passes file-parse's reader); absent: the index is left as it is
   */
  convert?: ReferenceConverter
}

/** Index the references; a failure here never fails the material change (reference-index.ts). */
async function syncQuietly(
  dir: string,
  files: readonly string[],
  convert: ReferenceConverter | undefined,
): Promise<void> {
  if (!convert) return
  await syncReferenceIndex(dir, files, convert).catch(() => undefined)
}

export function addReference(
  dir: string,
  originalPath: string,
  options: ReferenceOptions = {},
): Promise<ProjectFile> {
  return withProjectLock(dir, async () => {
    const project = await loadProject(dir)
    const name = await copyIntoWithSuffix(join(dir, 'references'), originalPath)
    const next = { ...project, references: [...project.references, name] }
    try {
      await saveProject(dir, next)
    } catch (e) {
      await removeQuietly(join(dir, 'references', name))
      throw e
    }
    await syncQuietly(dir, next.references, options.convert)
    return next
  })
}

export function removeReference(
  dir: string,
  file: string,
  options: ReferenceOptions = {},
): Promise<ProjectFile> {
  return withProjectLock(dir, async () => {
    assertPlainName(file)
    const project = await loadProject(dir)
    if (!project.references.includes(file)) throw new NotListedError(file)
    const next = { ...project, references: project.references.filter((r) => r !== file) }
    await saveProject(dir, next)
    await rm(join(dir, 'references', file), { force: true })
    await syncQuietly(dir, next.references, options.convert)
    return next
  })
}

/**
 * Bring the reference index in line with the project's list under the
 * project lock: references added before the index existed, or changed in
 * references/ by hand, are converted again. Answers each file's status.
 */
export function refreshReferences(
  dir: string,
  convert: ReferenceConverter,
): Promise<Record<string, ReferenceStatus>> {
  return withProjectLock(dir, async () => {
    const project = await loadProject(dir)
    return syncReferenceIndex(dir, project.references, convert)
  })
}

/** Merge entries in order, dropping exact duplicate source+target pairs. */
function mergeEntries(lists: GlossaryEntry[][]): GlossaryEntry[] {
  const seen = new Set<string>()
  const merged: GlossaryEntry[] = []
  for (const list of lists) {
    for (const entry of list) {
      const key = JSON.stringify([entry.source, entry.target])
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(entry)
    }
  }
  return merged
}

async function writeGlossaryJson(dir: string, entries: GlossaryEntry[]): Promise<void> {
  await mkdir(join(dir, STATE_DIR), { recursive: true })
  const target = join(dir, STATE_DIR, GLOSSARY_JSON)
  const tmp = join(dir, STATE_DIR, `${GLOSSARY_JSON}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(tmp, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
    await rename(tmp, target)
  } catch (e) {
    await removeQuietly(tmp)
    throw e
  }
}

async function readGlossaryFile(dir: string, file: string): Promise<GlossaryEntry[]> {
  return parseGlossary(await readFile(join(dir, 'glossary', file)), file)
}

async function rebuildGlossary(dir: string, files: string[]): Promise<void> {
  const lists: GlossaryEntry[][] = []
  for (const f of files) lists.push(await readGlossaryFile(dir, f))
  await writeGlossaryJson(dir, mergeEntries(lists))
}

/** Parse first so an unreadable glossary never leaves a copy behind. */
export function addGlossary(dir: string, originalPath: string): Promise<ProjectFile> {
  return withProjectLock(dir, async () => {
    const project = await loadProject(dir)
    parseGlossary(await readFile(originalPath), basename(originalPath))
    const name = await copyIntoWithSuffix(join(dir, 'glossary'), originalPath)
    const next = { ...project, glossaryFiles: [...project.glossaryFiles, name] }
    try {
      await rebuildGlossary(dir, next.glossaryFiles)
      await saveProject(dir, next)
    } catch (e) {
      await removeQuietly(join(dir, 'glossary', name))
      // Put the merged file back in line with the unchanged project; failure must not mask `e`.
      await rebuildGlossary(dir, project.glossaryFiles).catch(() => undefined)
      throw e
    }
    return next
  })
}

export function removeGlossary(dir: string, file: string): Promise<ProjectFile> {
  return withProjectLock(dir, async () => {
    assertPlainName(file)
    const project = await loadProject(dir)
    if (!project.glossaryFiles.includes(file)) throw new NotListedError(file)
    const next = { ...project, glossaryFiles: project.glossaryFiles.filter((g) => g !== file) }
    await rebuildGlossary(dir, next.glossaryFiles)
    try {
      await saveProject(dir, next)
    } catch (e) {
      await rebuildGlossary(dir, project.glossaryFiles).catch(() => undefined)
      throw e
    }
    await rm(join(dir, 'glossary', file), { force: true })
    return next
  })
}

/** Read the merged glossary; a missing file means no glossary yet. */
export async function loadGlossary(dir: string): Promise<GlossaryEntry[]> {
  let text: string
  try {
    text = await readFile(join(dir, STATE_DIR, GLOSSARY_JSON), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  return JSON.parse(text) as GlossaryEntry[]
}
