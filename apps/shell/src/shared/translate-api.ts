import type { OcrMode, ProjectFile } from '@genoffice/translate-project'
import type { OcrPageImage, OcrPageResult, OcrPrepared, OcrWritten } from './translate-ocr'
import type {
  TranslatePdfPrepared,
  TranslatePdfStoreAnswer,
  TranslatePdfStoreRequest,
  TranslatePdfWritten,
} from './translate-pdf'

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
  ocrPrepare: 'translate:ocr-prepare',
  ocrStart: 'translate:ocr-start',
  ocrPageImage: 'translate:ocr-page-image',
  ocrWrite: 'translate:ocr-write',
  ocrRelease: 'translate:ocr-release',
  instructionsFor: 'translate:instructions-for',
  pdfPrepare: 'translate:pdf-prepare',
  pdfStore: 'translate:pdf-store',
  pdfWrite: 'translate:pdf-write',
  pdfRelease: 'translate:pdf-release',
  openResult: 'translate:open-result',
  setSourceKind: 'translate:set-source-kind',
  pickExisting: 'translate:pick-existing',
  relocate: 'translate:relocate',
  recent: 'translate:recent',
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

/** one document opened lately in the translation view (kept in the app settings file) */
export interface TranslateRecentDocument {
  dir: string
  projectName: string
  /** the project's source file name; opening it goes through the usual open path */
  file: string
  sourceLang: string
  targetLang: string
  /** epoch milliseconds */
  openedAt: number
  /** false when the project folder, the source entry or its copy in source/ is gone */
  available: boolean
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

/**
 * A project folder the person picked and the app now lists (`pickExisting`,
 * `relocate`). `contextLinked` false: the folder holds AI instructions or
 * memory from elsewhere (or could not be listed), so it stays off the project
 * list, as "Add folder" in Projects leaves it, and the editors' AI panels do
 * not carry its translation context until the person adds it there.
 */
export interface TranslateAdoptedProject {
  dir: string
  name: string
  contextLinked: boolean
}

export interface TranslateRelocateArgs {
  /** the registered entry whose folder is gone; the picked folder replaces it */
  dir: string
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

/**
 * What "Open translation" did, by the source's kind:
 * - `edit`: an editable document; the split view is open;
 * - `translate-pdf`: a PDF with a text layer; nothing is open yet, the screen
 *   runs the translation job (confirmation first) and then `openResult`;
 * - `ocr`: a scanned PDF or an image; nothing is open yet, the screen runs
 *   the OCR window and then `openResult` with the Word document.
 * `existing` names the newest earlier result in output/ for that source
 * (null when there is none), so the screen can offer to open it instead.
 */
export type TranslateOpenTranslationResult =
  | {
      flow: 'edit'
      sourceTabId: string
      outputTabId: string
      hashStatus: TranslateSourceHashStatus
    }
  | {
      flow: 'translate-pdf'
      file: string
      hashStatus: TranslateSourceHashStatus
      existing: string | null
    }
  | {
      flow: 'ocr'
      kind: 'scan' | 'image'
      file: string
      hashStatus: TranslateSourceHashStatus
      existing: string | null
    }

export interface TranslateInstructionsForArgs {
  dir: string
  /** the request text the glossary entries are picked by */
  text: string
}

/**
 * What of the project goes with every request, for the screen to show before
 * anything is sent (read from the same composition as `prompts` and `material`).
 */
export interface TranslateContextSummary {
  /** the system prompt for all projects is not empty */
  systemPrompt: boolean
  /** this project's own prompt is not empty (the language pair always goes) */
  projectPrompt: boolean
  /** entries in the project's glossary */
  glossaryTotal: number
  /** over this many entries, each request carries only the entries whose terms appear in it */
  glossaryLimit: number
  /** reference file names (their names only; contents are never sent) */
  referenceNames: string[]
}

/** the translation context of one request: the person's prompts, and the glossary as material */
export interface TranslateInstructions {
  prompts: string
  material: string
  summary: TranslateContextSummary
}

export interface TranslatePdfPrepareArgs {
  dir: string
  /** the plain file name of one of the project's PDF sources */
  file: string
}

export interface TranslatePdfStoreArgs {
  token: string
  request: TranslatePdfStoreRequest
}

export interface TranslatePdfWriteArgs {
  token: string
  /** the translated page beside each original page (the PDF editor's bilingual option) */
  bilingual: boolean
}

export interface TranslateOpenResultArgs {
  dir: string
  /** the source the result was made from */
  file: string
  /** a plain file name in output/ */
  output: string
}

export interface TranslateSetSourceKindArgs {
  dir: string
  /** the plain file name of one of the project's PDF sources */
  file: string
  /** a text PDF (translated by the PDF engine) or a scan (read by OCR first) */
  kind: 'pdf' | 'scan'
}

export interface TranslateOpenResultAnswer {
  /** null when no editor shows the source (an image) */
  sourceTabId: string | null
  outputTabId: string
}

export interface TranslateSetPaneHiddenArgs {
  side: 'left' | 'right'
  hidden: boolean
}

export interface TranslateOcrPrepareArgs {
  dir: string
  /** plain file names of the project's sources: one PDF, or one or more images in reading order */
  files: string[]
}

export interface TranslateOcrStartArgs {
  token: string
  /** the confirmed 1-based items; main serves and accepts only these from now on */
  pages: number[]
}

export interface TranslateOcrPageImageArgs {
  token: string
  index: number
}

export interface TranslateOcrWriteArgs {
  token: string
  pages: OcrPageResult[]
}

export interface TranslateApi {
  list(): Promise<TranslateProjectListEntry[]>
  /** documents opened lately, newest first, at most 10 */
  recent(): Promise<TranslateRecentDocument[]>
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
  /**
   * OCR ("AI reading", spec 6.5; run by `runOcr` in shared/translate-ocr.ts):
   * list a scanned PDF's pages or the chosen images under a token. Nothing is
   * read or sent by this call. Refused with OCR_DISABLED when the project's OCR is off.
   */
  ocrPrepare(args: TranslateOcrPrepareArgs): Promise<OcrPrepared>
  /** after the person confirmed: fix the selection (one run per project at a time) */
  ocrStart(args: TranslateOcrStartArgs): Promise<void>
  /** one selected page or image, for the AI call the renderer makes */
  ocrPageImage(args: TranslateOcrPageImageArgs): Promise<OcrPageImage>
  /** write the readings into a new Word document in output/ (never overwriting) */
  ocrWrite(args: TranslateOcrWriteArgs): Promise<OcrWritten>
  /** drop the token (closing the dialog, stopping) */
  ocrRelease(token: string): Promise<void>
  /** the project's translation context for one request (prompts, glossary picked by `text`) */
  instructionsFor(args: TranslateInstructionsForArgs): Promise<TranslateInstructions>
  /** read a text PDF's document tree under a token for the translation job; sends nothing */
  pdfPrepare(args: TranslatePdfPrepareArgs): Promise<TranslatePdfPrepared>
  /** the job's result-store calls, for that token's document and language only */
  pdfStore(args: TranslatePdfStoreArgs): Promise<TranslatePdfStoreAnswer>
  /** write the translated PDF from what is stored into output/ (never overwriting) */
  pdfWrite(args: TranslatePdfWriteArgs): Promise<TranslatePdfWritten>
  pdfRelease(token: string): Promise<void>
  /** the source copy read-only on the left (when an editor shows it) and a result on the right */
  openResult(args: TranslateOpenResultArgs): Promise<TranslateOpenResultAnswer>
  /** the person's correction of a PDF source's kind; remembered for that copy */
  setSourceKind(args: TranslateSetSourceKindArgs): Promise<ProjectFile>
  /**
   * add a translation project folder made elsewhere (moved, copied, or listed
   * before): main opens the folder dialog; null when cancelled. Refused with
   * NOT_A_PROJECT when the folder holds no valid project file.
   */
  pickExisting(): Promise<TranslateAdoptedProject | null>
  /** a listed project whose folder is gone: pick where it is now; null when cancelled */
  relocate(args: TranslateRelocateArgs): Promise<TranslateAdoptedProject | null>
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
  | 'OCR_DISABLED'
  | 'EMPTY_SELECTION'
  | 'OCR_CANCELLED'
  | 'OCR_BUSY'
  | 'OCR_EXPIRED'
  | 'OCR_FAILED'
  | 'UNSUPPORTED_LANGUAGE'
  | 'TRANSLATE_BUSY'
  | 'TRANSLATE_EXPIRED'
  | 'TRANSLATE_FAILED'
  | 'SOURCE_CHANGED'
  | 'PROJECT_IN_USE'
  | 'GLOSSARY_INVALID'
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
  'OCR_DISABLED',
  'EMPTY_SELECTION',
  'OCR_CANCELLED',
  'OCR_BUSY',
  'OCR_EXPIRED',
  'OCR_FAILED',
  'UNSUPPORTED_LANGUAGE',
  'TRANSLATE_BUSY',
  'TRANSLATE_EXPIRED',
  'TRANSLATE_FAILED',
  'SOURCE_CHANGED',
  'PROJECT_IN_USE',
  'GLOSSARY_INVALID',
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
  OcrDisabledError: 'OCR_DISABLED',
  EmptyOcrSelectionError: 'EMPTY_SELECTION',
  InvalidOcrSelectionError: 'INVALID_ARGUMENT',
  OcrCancelledError: 'OCR_CANCELLED',
  OcrFailedError: 'OCR_FAILED',
  InvalidSourceKindError: 'INVALID_ARGUMENT',
  UnsupportedTargetLanguageError: 'UNSUPPORTED_LANGUAGE',
  SourceChangedError: 'SOURCE_CHANGED',
  SourceKindChosenError: 'INVALID_ARGUMENT',
  GlossaryFormatError: 'GLOSSARY_INVALID',
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
