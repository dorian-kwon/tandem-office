import { NotListedError } from './materials'
import type { ProjectFile, SourceKind } from './project-file'
import { withProjectLock } from './project-lock'
import { loadProject, saveProject } from './project-store'

const SOURCE_KINDS: readonly SourceKind[] = ['editable', 'pdf', 'scan', 'image']

export class InvalidSourceKindError extends Error {
  constructor(kind: unknown) {
    super(`not a source kind: ${JSON.stringify(kind)}`)
    this.name = 'InvalidSourceKindError'
  }
}

/**
 * Record a new kind for one listed source (for example a PDF found to be a
 * scan when it is first opened). Only the `kind` of that entry changes; its
 * file name and hash stay. Runs under the project lock, so a concurrent
 * material change is not lost. An unchanged kind writes nothing.
 */
export function setSourceKind(dir: string, file: string, kind: SourceKind): Promise<ProjectFile> {
  return withProjectLock(dir, async () => {
    if (!SOURCE_KINDS.includes(kind)) throw new InvalidSourceKindError(kind)
    if (file === '' || file === '.' || file === '..' || /[\\/]/.test(file) || file.includes('\0'))
      throw new NotListedError(file)
    const project = await loadProject(dir)
    const entry = project.sources.find((s) => s.file === file)
    if (!entry) throw new NotListedError(file)
    if (entry.kind === kind) return project
    const next: ProjectFile = {
      ...project,
      sources: project.sources.map((s) => (s.file === file ? { ...s, kind } : s)),
    }
    await saveProject(dir, next)
    return next
  })
}
