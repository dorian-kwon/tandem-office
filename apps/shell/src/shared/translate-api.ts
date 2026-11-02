import type { OcrMode, ProjectFile } from '@genoffice/translate-project'

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
  updateSettings: 'translate:update-settings',
  addMaterial: 'translate:add-material',
  removeMaterial: 'translate:remove-material',
  pickMaterials: 'translate:pick-materials',
  pickParentDir: 'translate:pick-parent-dir',
  openTranslation: 'translate:open-translation',
  setPaneHidden: 'translate:set-pane-hidden',
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
  /** token from `pickParentDir`: main only creates inside a folder the person picked */
  parentToken: string
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
  /** token from `pickMaterials` of the same kind */
  token: string
  /** which of the picked files (position in the returned `names`) */
  index: number
}

export interface TranslatePickedMaterials {
  token: string
  /** plain file names only; the renderer never sees the paths */
  names: string[]
}

export interface TranslatePickedParentDir {
  token: string
  /** shown to the person so they know where the project goes */
  dir: string
}

/** The only project fields the renderer may change; material lists are never in it. */
export interface TranslateSettingsPatch {
  projectPrompt?: string
  ocr?: OcrMode
  sourceLang?: string
  targetLang?: string
}

export interface TranslateUpdateSettingsArgs {
  dir: string
  patch: TranslateSettingsPatch
}

export interface TranslateRemoveMaterialArgs {
  dir: string
  kind: TranslateMaterialKind
  /** the plain file name listed in the project */
  file: string
}

export interface TranslateOpenTranslationArgs {
  dir: string
  /** the plain file name of one of the project's sources */
  file: string
}

/** 'changed': the copy in source/ no longer matches the hash recorded when it was added */
export type TranslateSourceHashStatus = 'ok' | 'changed' | 'missing'

export interface TranslateOpenTranslationResult {
  sourceTabId: string
  outputTabId: string
  hashStatus: TranslateSourceHashStatus
}

export interface TranslateSetPaneHiddenArgs {
  side: 'left' | 'right'
  hidden: boolean
}

export interface TranslateApi {
  list(): Promise<TranslateProjectListEntry[]>
  create(args: TranslateCreateArgs): Promise<{ dir: string }>
  remove(args: TranslateRemoveArgs): Promise<void>
  getSystemPrompt(): Promise<string>
  setSystemPrompt(text: string): Promise<void>
  getProject(dir: string): Promise<ProjectFile>
  /** change only the settings fields; returns the full updated project */
  updateSettings(args: TranslateUpdateSettingsArgs): Promise<ProjectFile>
  addMaterial(args: TranslateAddMaterialArgs): Promise<ProjectFile>
  removeMaterial(args: TranslateRemoveMaterialArgs): Promise<ProjectFile>
  /** opens the native file dialog; null when cancelled */
  pickMaterials(kind: TranslateMaterialKind): Promise<TranslatePickedMaterials | null>
  /** opens the native folder dialog; null when cancelled */
  pickParentDir(): Promise<TranslatePickedParentDir | null>
  /** the translation view: the source copy read-only on the left, the output copy on the right */
  openTranslation(args: TranslateOpenTranslationArgs): Promise<TranslateOpenTranslationResult>
  /** hide or show one pane of the translation view (only one can be hidden) */
  setPaneHidden(args: TranslateSetPaneHiddenArgs): Promise<void>
}

// ---- errors ----
// Electron flattens an error thrown in a handler to an English string with no
// code, so every handler throws a TranslateIpcError whose message starts with
// a stable bracketed code, e.g. `[PROJECT_EXISTS] project folder already exists: ...`.

export type TranslateErrorCode =
  | 'PROJECT_EXISTS'
  | 'INVALID_PROJECT_NAME'
  | 'NOT_LISTED'
  | 'NOT_A_PROJECT'
  | 'UNSUPPORTED_SOURCE'
  | 'NOT_REGISTERED'
  | 'INVALID_ARGUMENT'
  | 'PROJECT_FILE_INVALID'
  | 'SOURCE_MISSING'
  | 'SOURCE_NOT_EDITABLE'
  | 'OPEN_FAILED'
  | 'UNKNOWN'

const TRANSLATE_ERROR_CODES: readonly TranslateErrorCode[] = [
  'PROJECT_EXISTS',
  'INVALID_PROJECT_NAME',
  'NOT_LISTED',
  'NOT_A_PROJECT',
  'UNSUPPORTED_SOURCE',
  'NOT_REGISTERED',
  'INVALID_ARGUMENT',
  'PROJECT_FILE_INVALID',
  'SOURCE_MISSING',
  'SOURCE_NOT_EDITABLE',
  'OPEN_FAILED',
  'UNKNOWN',
]

export class TranslateIpcError extends Error {
  readonly code: TranslateErrorCode
  constructor(code: TranslateErrorCode, text: string) {
    super(`[${code}] ${text}`)
    this.name = 'TranslateIpcError'
    this.code = code
  }
}

// keyed by error name so this file stays free of Node-only imports (the
// renderer imports it too)
const CODE_BY_ERROR_NAME: Record<string, TranslateErrorCode> = {
  ProjectExistsError: 'PROJECT_EXISTS',
  InvalidProjectNameError: 'INVALID_PROJECT_NAME',
  NotListedError: 'NOT_LISTED',
  NotAProjectError: 'NOT_A_PROJECT',
  UnsupportedSourceError: 'UNSUPPORTED_SOURCE',
  ProjectFileError: 'PROJECT_FILE_INVALID',
}

/** Map a translate-project error (or anything else) to a TranslateIpcError. */
export function toTranslateIpcError(err: unknown): TranslateIpcError {
  if (err instanceof TranslateIpcError) return err
  const text = err instanceof Error ? err.message : String(err)
  const code = err instanceof Error ? CODE_BY_ERROR_NAME[err.name] : undefined
  return new TranslateIpcError(code ?? 'UNKNOWN', text)
}

/**
 * Read the code and clean message from a TranslateIpcError or from Electron's
 * wrapped message (`Error invoking remote method '...': Error: [CODE] text`).
 */
export function parseTranslateError(err: unknown): { code: TranslateErrorCode; message: string } {
  const raw = err instanceof Error ? err.message : String(err)
  const match = /\[([A-Z_]+)\] ([\s\S]*)$/.exec(raw)
  const code = TRANSLATE_ERROR_CODES.find((c) => c === match?.[1])
  if (match && code) return { code, message: match[2] ?? '' }
  return { code: 'UNKNOWN', message: raw }
}
