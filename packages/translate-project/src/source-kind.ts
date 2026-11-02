import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NotListedError } from './materials'
import type { ProjectFile, SourceKind } from './project-file'
import { withProjectLock } from './project-lock'
import { loadProject, saveProject } from './project-store'

const SOURCE_KINDS: readonly SourceKind[] = ['editable', 'pdf', 'scan', 'image']

const STATE_DIR = '.tandem'
/** the kinds the person chose by hand, per source copy (file name and hash) */
const CHOICES_JSON = 'source-kinds.json'

export class InvalidSourceKindError extends Error {
  constructor(kind: unknown) {
    super(`not a source kind: ${JSON.stringify(kind)}`)
    this.name = 'InvalidSourceKindError'
  }
}

/** the listed entry is not the copy the kind was decided for any more */
export class SourceChangedError extends Error {
  constructor(file: string) {
    super(`the source changed since its kind was decided: ${JSON.stringify(file)}`)
    this.name = 'SourceChangedError'
  }
}

export interface SetSourceKindOptions {
  /** refuse when the entry's hash is no longer this one (the copy the kind was decided for) */
  expectedSha256?: string
  /**
   * the person chose this kind by hand: it is remembered for this copy so an
   * automatic check never overrides it (chosenSourceKind)
   */
  chosenByPerson?: boolean
}

type Choices = Record<string, { sha256: string; kind: SourceKind }>

async function readChoices(dir: string): Promise<Choices> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(dir, STATE_DIR, CHOICES_JSON), 'utf8'))
    const chosen = (raw as { chosen?: unknown } | null)?.chosen
    if (typeof chosen !== 'object' || chosen === null || Array.isArray(chosen)) return {}
    const out: Choices = {}
    for (const [file, v] of Object.entries(chosen as Record<string, unknown>)) {
      const entry = v as { sha256?: unknown; kind?: unknown } | null
      if (typeof entry?.sha256 !== 'string') continue
      const kind = SOURCE_KINDS.find((k) => k === entry.kind)
      if (kind) out[file] = { sha256: entry.sha256, kind }
    }
    return out
  } catch {
    // missing or damaged: no choice recorded
    return {}
  }
}

async function writeChoices(dir: string, chosen: Choices): Promise<void> {
  await mkdir(join(dir, STATE_DIR), { recursive: true })
  const target = join(dir, STATE_DIR, CHOICES_JSON)
  const tmp = join(dir, STATE_DIR, `${CHOICES_JSON}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(tmp, `${JSON.stringify({ version: 1, chosen }, null, 2)}\n`, 'utf8')
    await rename(tmp, target)
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw e
  }
}

/** the kind the person chose by hand for this copy (name and hash), or null */
export async function chosenSourceKind(
  dir: string,
  file: string,
  sha256: string,
): Promise<SourceKind | null> {
  const choice = (await readChoices(dir))[file]
  return choice && choice.sha256 === sha256 ? choice.kind : null
}

/**
 * Record a new kind for one listed source (for example a PDF found to be a
 * scan when it is first opened, or the person's own correction). Only the
 * `kind` of that entry changes; its file name and hash stay. Runs under the
 * project lock, so a concurrent material change is not lost. An unchanged
 * kind writes nothing to project.json.
 */
export function setSourceKind(
  dir: string,
  file: string,
  kind: SourceKind,
  options: SetSourceKindOptions = {},
): Promise<ProjectFile> {
  return withProjectLock(dir, async () => {
    if (!SOURCE_KINDS.includes(kind)) throw new InvalidSourceKindError(kind)
    if (file === '' || file === '.' || file === '..' || /[\\/]/.test(file) || file.includes('\0'))
      throw new NotListedError(file)
    const project = await loadProject(dir)
    const entry = project.sources.find((s) => s.file === file)
    if (!entry) throw new NotListedError(file)
    if (options.expectedSha256 !== undefined && entry.sha256 !== options.expectedSha256)
      throw new SourceChangedError(file)
    if (options.chosenByPerson) {
      const chosen = await readChoices(dir)
      chosen[file] = { sha256: entry.sha256, kind }
      await writeChoices(dir, chosen)
    }
    if (entry.kind === kind) return project
    const next: ProjectFile = {
      ...project,
      sources: project.sources.map((s) => (s.file === file ? { ...s, kind } : s)),
    }
    await saveProject(dir, next)
    return next
  })
}
