import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  defaultProjectFile,
  parseProjectFile,
  serializeProjectFile,
  type ProjectFile,
} from './project-file'

const STATE_DIR = '.tandem'
const PROJECT_FILE = 'project.json'
const SUBFOLDERS = ['source', 'references', 'glossary', 'output'] as const

export class ProjectExistsError extends Error {
  constructor(dir: string) {
    super(`project folder already exists: ${dir}`)
    this.name = 'ProjectExistsError'
  }
}

export class InvalidProjectNameError extends Error {
  constructor(name: string) {
    super(`invalid project name: ${JSON.stringify(name)}`)
    this.name = 'InvalidProjectNameError'
  }
}

export class NotAProjectError extends Error {
  constructor(dir: string) {
    super(`not a translation project: ${dir}`)
    this.name = 'NotAProjectError'
  }
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

const projectFilePath = (dir: string): string => join(dir, STATE_DIR, PROJECT_FILE)

/** Strip characters that are invalid in file names on Windows or POSIX. */
function safeFolderName(name: string): string {
  const noInvalid = [...name]
    .filter((c) => c.charCodeAt(0) > 0x1f && !'<>:"/\\|?*'.includes(c))
    .join('')
  const trimmed = noInvalid.replace(/[. ]+$/, '').trim()
  if (trimmed === '' || trimmed === '.' || trimmed === '..') throw new InvalidProjectNameError(name)
  // Windows device names are rejected on every platform because folders move between systems.
  if (WINDOWS_RESERVED.test(trimmed)) throw new InvalidProjectNameError(name)
  return trimmed
}

export async function createProject(
  parentDir: string,
  name: string,
  sourceLang: string,
  targetLang: string,
): Promise<{ dir: string; project: ProjectFile }> {
  const dir = join(parentDir, safeFolderName(name))
  try {
    await mkdir(dir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new ProjectExistsError(dir)
    throw e
  }
  try {
    for (const sub of SUBFOLDERS) await mkdir(join(dir, sub))
    await mkdir(join(dir, STATE_DIR))
    const project = defaultProjectFile(name, sourceLang, targetLang)
    await saveProject(dir, project)
    return { dir, project }
  } catch (e) {
    // This call just created the directory, so removing it on failure is safe.
    try {
      await rm(dir, { recursive: true, force: true })
    } catch {
      // Cleanup is best effort; the original failure is the one worth reporting.
    }
    throw e
  }
}

export async function loadProject(dir: string): Promise<ProjectFile> {
  return parseProjectFile(await readFile(projectFilePath(dir), 'utf8'))
}

/** Write to a temp file in the state folder, then rename onto project.json. */
export async function saveProject(dir: string, p: ProjectFile): Promise<void> {
  const target = projectFilePath(dir)
  const tmp = join(dir, STATE_DIR, `project.json.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(tmp, serializeProjectFile(p), 'utf8')
    await rename(tmp, target)
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw e
  }
}

export async function projectStatus(dir: string): Promise<'ok' | 'not-found' | 'invalid'> {
  const info = await stat(dir).catch(() => null)
  if (!info?.isDirectory()) return 'not-found'
  let text: string
  try {
    text = await readFile(projectFilePath(dir), 'utf8')
  } catch {
    return 'not-found'
  }
  try {
    parseProjectFile(text)
    return 'ok'
  } catch {
    return 'invalid'
  }
}

/** Optionally delete the project folder; refuses unless it holds a valid project file. */
export async function removeProject(dir: string, opts: { deleteFolder: boolean }): Promise<void> {
  if (!opts.deleteFolder) return
  if ((await projectStatus(dir)) !== 'ok') throw new NotAProjectError(dir)
  await rm(dir, { recursive: true, force: true })
}
