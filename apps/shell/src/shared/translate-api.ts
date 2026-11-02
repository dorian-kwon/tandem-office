import type { ProjectFile } from '@genoffice/translate-project'

/**
 * The translation tool's project bridge (main process side: `translate-ipc.ts`).
 * Every channel is prefixed `translate:` so names stay unique process-wide.
 * The renderer names a project by its folder, and main only accepts folders
 * in the registered list (`translationProjects` in app-settings.json).
 */
export const TRANSLATE_CHANNELS = {
  list: 'translate:list',
  create: 'translate:create',
  remove: 'translate:remove',
  getSystemPrompt: 'translate:get-system-prompt',
  setSystemPrompt: 'translate:set-system-prompt',
  getProject: 'translate:get-project',
  saveProject: 'translate:save-project',
  addMaterial: 'translate:add-material',
  removeMaterial: 'translate:remove-material',
} as const

export type TranslateMaterialKind = 'source' | 'reference' | 'glossary'

export type TranslateProjectStatus = 'ok' | 'not-found' | 'invalid'

export interface TranslateProjectListEntry {
  dir: string
  name: string
  status: TranslateProjectStatus
  sourceLang: string
  targetLang: string
  /** epoch milliseconds, kept in the settings list only (never in project.json) */
  lastOpened: number
}

export interface TranslateCreateArgs {
  parentDir: string
  name: string
  sourceLang: string
  targetLang: string
}

export interface TranslateRemoveArgs {
  dir: string
  deleteFolder: boolean
}

export interface TranslateAddMaterialArgs {
  dir: string
  kind: TranslateMaterialKind
  /** a file the person picked in a file dialog */
  path: string
}

export interface TranslateRemoveMaterialArgs {
  dir: string
  kind: TranslateMaterialKind
  /** the plain file name listed in the project */
  file: string
}

export interface TranslateApi {
  list(): Promise<TranslateProjectListEntry[]>
  create(args: TranslateCreateArgs): Promise<{ dir: string }>
  remove(args: TranslateRemoveArgs): Promise<void>
  getSystemPrompt(): Promise<string>
  setSystemPrompt(text: string): Promise<void>
  getProject(dir: string): Promise<ProjectFile>
  saveProject(dir: string, project: ProjectFile): Promise<void>
  addMaterial(args: TranslateAddMaterialArgs): Promise<ProjectFile>
  removeMaterial(args: TranslateRemoveMaterialArgs): Promise<ProjectFile>
}
