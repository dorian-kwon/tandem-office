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

/** an automatic change was asked for a copy whose kind the person chose by hand */
export class SourceKindChosenError extends Error {
  constructor(file: string) {
    super(`the person chose the kind of this source by hand: ${JSON.stringify(file)}`)
    this.name = 'SourceKindChosenError'
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

/** file name → the copy (hash) and the kind the person chose; a Map, so no key reaches a prototype */
type Choices = Map<string, { sha256: string; kind: SourceKind }>

/** a key a source can have: a plain file name (never `__proto__` and the like) */
function choiceKey(file: string): boolean {
  return (
    file !== '' &&
    file !== '.' &&
    file !== '..' &&
    file !== '__proto__' &&
    !/[\\/]/.test(file) &&
    !file.includes('\0')
  )
}

async function readChoices(dir: string): Promise<Choices> {
  const out: Choices = new Map()
  try {
    const raw: unknown = JSON.parse(await readFile(join(dir, STATE_DIR, CHOICES_JSON), 'utf8'))
    const chosen = (raw as { chosen?: unknown } | null)?.chosen
    if (typeof chosen !== 'object' || chosen === null || Array.isArray(chosen)) return out
    for (const [file, v] of Object.entries(chosen as Record<string, unknown>)) {
      if (!choiceKey(file)) continue
      const entry = v as { sha256?: unknown; kind?: unknown } | null
      if (typeof entry?.sha256 !== 'string') continue
      const kind = SOURCE_KINDS.find((k) => k === entry.kind)
      if (kind) out.set(file, { sha256: entry.sha256, kind })
    }
    return out
  } catch {
    // missing or damaged: no choice recorded
    return out
  }
}

async function writeChoices(dir: string, choices: Choices): Promise<void> {
  const chosen: Record<string, { sha256: string; kind: SourceKind }> = Object.create(null)
  for (const [file, v] of choices) chosen[file] = v
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
  const choice = (await readChoices(dir)).get(file)
  return choice && choice.sha256 === sha256 ? choice.kind : null
}

/**
 * Record a new kind for one listed source (for example a PDF found to be a
 * scan when it is first opened, or the person's own correction). Only the
 * `kind` of that entry changes; its file name and hash stay. Runs under the
 * project lock, so a concurrent material change is not lost. An unchanged
 * kind writes nothing to project.json. An automatic change (no
 * `chosenByPerson`) is refused with SourceKindChosenError when the person
 * chose the kind of this copy by hand, so a check still in flight cannot
 * overwrite that choice.
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
    const chosen = await readChoices(dir)
    const earlier = chosen.get(file)
    // an automatic check never overrides the person's choice for this copy
    if (!options.chosenByPerson && earlier && earlier.sha256 === entry.sha256)
      throw new SourceKindChosenError(file)
    // project.json first: if the choices file then cannot be written, the kind is
    // still what the person asked for this time (only its protection is missing)
    const next: ProjectFile =
      entry.kind === kind
        ? project
        : {
            ...project,
            sources: project.sources.map((s) => (s.file === file ? { ...s, kind } : s)),
          }
    if (next !== project) await saveProject(dir, next)
    if (options.chosenByPerson) {
      chosen.set(file, { sha256: entry.sha256, kind })
      await writeChoices(dir, chosen)
    }
    return next
  })
}
