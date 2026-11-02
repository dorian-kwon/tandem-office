import type { ProjectId } from '@genoffice/project-store'
import type { ProjectGuide } from '../projects/project-guide'
import { canonicalPath, samePath } from '../projects/paths'

/**
 * A translation project folder is also a project folder (decision 0088), so
 * the editors' AI panels send its context (see `context-injection.ts`) with no
 * picking by the person: a document inside a listed folder starts with that
 * project unless the person chose "no project" for it (`selection.ts`).
 */
export interface TranslationProjectLink {
  /**
   * List `dir` as a project folder; its project id, or null when the folder
   * could not be listed (refused, or it holds instructions or memory from
   * elsewhere, which only the person can confirm through "Add folder").
   */
  ensureListed(dir: string): Promise<ProjectId | null>
  /** Take `dir` off the project list, if it is on it (its trust record stays, as "Remove from list" keeps it) */
  unlist(dir: string): Promise<void>
}

/**
 * The link over the project guide. Listing goes through the guide's own
 * add-folder rules (refusals, identity, trust) with a trust prompt that can
 * never be answered: a folder with nothing to confirm is trusted as "Add
 * folder" trusts it; a folder holding foreign instructions, memory or chats
 * is left unlisted instead of being trusted without the person. A trust
 * decision already on record (also "without") is kept.
 *
 * `onChanged` runs when the list changed (the shell refreshes its project
 * file walks).
 */
export function translationProjectLink(
  guide: Pick<ProjectGuide, 'addFolder' | 'listProjects' | 'removeFromList'>,
  onChanged?: () => void,
  platform: NodeJS.Platform = process.platform,
): TranslationProjectLink {
  return {
    async ensureListed(dir) {
      const result = await guide.addFolder(dir, async () => null)
      if (result.status !== 'added') return null
      if (result.identity !== 'existing') onChanged?.()
      return result.project.id
    },
    async unlist(dir) {
      const key = canonicalPath(dir)
      const listed = (await guide.listProjects()).filter((item) =>
        samePath(item.path, key, platform),
      )
      for (const item of listed) await guide.removeFromList(item.id)
      if (listed.length > 0) onChanged?.()
    },
  }
}
