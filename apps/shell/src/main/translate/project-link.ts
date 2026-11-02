import type { ProjectId } from '@genoffice/project-store'
import type { ProjectGuide } from '../projects/project-guide'

/**
 * A translation project folder is also a project folder (decision 0088), so
 * the editors' AI panels send its context (see `context-injection.ts`) with no
 * picking by the person.
 */
export interface TranslationProjectLink {
  /**
   * List `dir` as a project folder; its project id, or null when the folder
   * could not be listed (refused, or it holds instructions or memory from
   * elsewhere, which only the person can confirm through "Add folder").
   */
  ensureListed(dir: string): Promise<ProjectId | null>
  /** Make each document's AI panel start with `projectId` (undoes an earlier "no project") */
  selectFor(projectId: ProjectId, paths: string[]): Promise<void>
}

/**
 * The link over the project guide. Listing goes through the guide's own
 * add-folder rules (refusals, identity, trust) with a trust prompt that can
 * never be answered: a folder with nothing to confirm is trusted as "Add
 * folder" trusts it; a folder holding foreign instructions, memory or chats
 * is left unlisted instead of being trusted without the person. A trust
 * decision already on record (also "without") is kept.
 *
 * `onListed` runs when a folder was newly listed (the shell refreshes its
 * project file walks).
 */
export function translationProjectLink(
  guide: Pick<ProjectGuide, 'addFolder' | 'setSelection'>,
  onListed?: () => void,
): TranslationProjectLink {
  return {
    async ensureListed(dir) {
      const result = await guide.addFolder(dir, async () => null)
      if (result.status !== 'added') return null
      if (result.identity !== 'existing') onListed?.()
      return result.project.id
    },
    async selectFor(projectId, paths) {
      for (const path of paths) await guide.setSelection({ kind: 'document', path }, projectId)
    },
  }
}
