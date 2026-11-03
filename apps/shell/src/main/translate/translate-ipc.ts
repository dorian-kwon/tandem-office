import { randomUUID } from 'node:crypto'
import { rm, stat } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import type { IpcMain } from 'electron'
import {
  addGlossary,
  addReference,
  addSource,
  createProject,
  DEFAULT_GLOSSARY_LIMIT,
  EDITABLE_SOURCE_EXTENSIONS,
  IMAGE_SOURCE_EXTENSIONS,
  loadProject,
  NotAProjectError,
  parseProjectFile,
  projectStatus,
  readConvertedReference,
  referenceStatuses,
  refreshReferences,
  removeGlossary,
  removeProject,
  removeReference,
  removeSource,
  saveProject,
  withProjectLock,
  type ProjectFile,
  type ReferenceConverter,
} from '@genoffice/translate-project'
import { convertReference } from './reference-convert'
import { PickAllowlist } from './pick-allowlist'
import { createOcrService, type OcrService, type OcrServiceDeps } from './ocr'
import { buildTranslationInstructions } from './context-injection'
import {
  createNonEditableService,
  type NonEditableDeps,
  type NonEditableService,
} from './non-editable'
import {
  openTranslation,
  openTranslationResult,
  type TranslationViewDeps,
} from './open-translation'
import { listRecentDocuments, recordRecentDocument } from './recent-documents'
import type { TranslationProjectLink } from './project-link'
import {
  readTranslationProjects,
  readTranslationSystemPrompt,
  writeTranslationProjects,
  writeTranslationSystemPrompt,
} from '../app-settings'
import {
  TRANSLATE_CHANNELS,
  toTranslateIpcError,
  TranslateIpcError,
  type TranslateAddMaterialArgs,
  type TranslateAdoptedProject,
  type TranslateCreateArgs,
  type TranslateInstructions,
  type TranslateInstructionsForArgs,
  type TranslateMaterialKind,
  type TranslateOcrPageImageArgs,
  type TranslateOcrPrepareArgs,
  type TranslateOcrStartArgs,
  type TranslateOcrWriteArgs,
  type TranslateOpenTranslationArgs,
  type TranslateOpenResultAnswer,
  type TranslateOpenResultArgs,
  type TranslateOpenTranslationResult,
  type TranslatePdfPrepareArgs,
  type TranslatePdfStoreArgs,
  type TranslatePdfWriteArgs,
  type TranslateSetSourceKindArgs,
  type TranslatePickedMaterials,
  type TranslatePickedParentDir,
  type TranslateProjectListEntry,
  type TranslateRecentDocument,
  type TranslateReferenceStatus,
  type TranslateReferenceText,
  type TranslateReferenceTextArgs,
  type TranslateRemoveArgs,
  type TranslateRelocateArgs,
  type TranslateRemoveMaterialArgs,
  type TranslateSetPaneHiddenArgs,
  type TranslateUpdateSettingsArgs,
} from '../../shared/translate-api'

/**
 * The translation tool's project handlers (channels in `shared/translate-api.ts`).
 * They are plain functions over injected dependencies so tests run without
 * Electron; `registerTranslateIpc` only wires them to `ipcMain`.
 *
 * A renderer never gets arbitrary-path access: every handler that takes a
 * `dir` first checks it against the registered list in app-settings.json.
 */

export interface TranslateIpcDeps {
  /** path of userData/app-settings.json (read per call: userData is final only after ready) */
  settingsPath: () => string
  now: () => number
  /** the native open dialog (injected so tests run without Electron) */
  showOpenDialog: (
    options: OpenDialogOptions,
  ) => Promise<{ canceled: boolean; filePaths: string[] }>
  /** override for the allowlist token generator (tests) */
  newToken?: () => string
  /** the shell's tabs for the translation view; absent where there is no tab strip */
  view?: TranslationViewDeps
  /** lists translation folders as project folders (decision 0088); absent: they are not */
  projects?: TranslationProjectLink
  /** page rendering and the .docx conversion for OCR (main/translate/ocr.ts); absent: no OCR */
  ocr?: OcrServiceDeps
  /**
   * scan detection, the PDF's tree, the result store and the translated-PDF
   * writer (main/translate/non-editable.ts); absent: PDF sources are not
   * checked for scans and a text PDF cannot be translated
   */
  nonEditable?: NonEditableDeps
  /**
   * whether any open tab or window (split panes, the read-only source tab and
   * detached windows included) shows a file under `dir`; a project folder is
   * never deleted while it does. Absent: nothing is open (tests).
   */
  isPathOpen?: (dir: string) => boolean
  /**
   * a reference file as markdown for the keyword index; absent: file-parse's reader
   * (reference-convert.ts). Tests inject one.
   */
  convertReference?: ReferenceConverter
}

/** the converted text the detail screen shows at most (a whole book is far shorter) */
export const REFERENCE_VIEW_MAX_CHARS = 2_000_000

/** the longest request text the glossary entries are picked by (a batch is far shorter) */
export const INSTRUCTIONS_TEXT_LIMIT = 400_000

export interface OpenDialogOptions {
  title?: string
  properties: ('openFile' | 'openDirectory' | 'multiSelections' | 'createDirectory')[]
  filters?: { name: string; extensions: string[] }[]
}

/** what the add-source dialog offers: the types `classifySource` accepts, nothing else */
export const SOURCE_DIALOG_EXTENSIONS: readonly string[] = [
  ...EDITABLE_SOURCE_EXTENSIONS,
  'pdf',
  ...IMAGE_SOURCE_EXTENSIONS,
]

const FILTERS: Record<TranslateMaterialKind, { name: string; extensions: string[] }[]> = {
  source: [{ name: 'Documents', extensions: [...SOURCE_DIALOG_EXTENSIONS] }],
  reference: [{ name: 'All files', extensions: ['*'] }],
  glossary: [{ name: 'Glossary', extensions: ['csv', 'txt', 'xlsx'] }],
}

const SETTINGS_KEYS = ['projectPrompt', 'ocr', 'sourceLang', 'targetLang']

const KINDS: readonly TranslateMaterialKind[] = ['source', 'reference', 'glossary']

function fold(path: string): string {
  const full = resolve(path)
  return process.platform === 'win32' ? full.toLowerCase() : full
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '')
    throw new TranslateIpcError('INVALID_ARGUMENT', `${what} must be a non-empty string`)
  return value
}

function requireKind(value: unknown): TranslateMaterialKind {
  const kind = KINDS.find((k) => k === value)
  if (!kind) throw new TranslateIpcError('INVALID_ARGUMENT', 'unknown material kind')
  return kind
}

export function createTranslateHandlers(deps: TranslateIpcDeps) {
  const raw = createRawHandlers(deps)
  return {
    list: guard(raw.list),
    recent: guard(raw.recent),
    create: guard(raw.create),
    remove: guard(raw.remove),
    getSystemPrompt: guard(raw.getSystemPrompt),
    setSystemPrompt: guard(raw.setSystemPrompt),
    getProject: guard(raw.getProject),
    updateSettings: guard(raw.updateSettings),
    addMaterial: guard(raw.addMaterial),
    removeMaterial: guard(raw.removeMaterial),
    pickMaterials: guard(raw.pickMaterials),
    pickParentDir: guard(raw.pickParentDir),
    openTranslation: guard(raw.openTranslation),
    setPaneHidden: guard(raw.setPaneHidden),
    ocrPrepare: guard(raw.ocrPrepare),
    ocrStart: guard(raw.ocrStart),
    ocrPageImage: guard(raw.ocrPageImage),
    ocrWrite: guard(raw.ocrWrite),
    ocrRelease: guard(raw.ocrRelease),
    ocrForgetOwner: guard(raw.ocrForgetOwner),
    instructionsFor: guard(raw.instructionsFor),
    pdfPrepare: guard(raw.pdfPrepare),
    pdfStore: guard(raw.pdfStore),
    pdfWrite: guard(raw.pdfWrite),
    pdfRelease: guard(raw.pdfRelease),
    openResult: guard(raw.openResult),
    setSourceKind: guard(raw.setSourceKind),
    pickExisting: guard(raw.pickExisting),
    relocate: guard(raw.relocate),
    referenceStatus: guard(raw.referenceStatus),
    referenceText: guard(raw.referenceText),
  }
}

/** Run a handler so any failure leaves as a TranslateIpcError with a stable code. */
function guard<A extends unknown[], R>(fn: (...a: A) => Promise<R>): (...a: A) => Promise<R> {
  return async (...a) => {
    try {
      return await fn(...a)
    } catch (err) {
      throw toTranslateIpcError(err)
    }
  }
}

function createRawHandlers(deps: TranslateIpcDeps) {
  const materialPicks = new PickAllowlist<TranslateMaterialKind>(deps.now, deps.newToken)
  const parentPicks = new PickAllowlist<null>(deps.now, deps.newToken)
  const newToken = deps.newToken ?? (() => randomUUID())
  const convert: ReferenceConverter = deps.convertReference ?? convertReference
  const ocrService: OcrService | null = deps.ocr
    ? createOcrService(deps.ocr, deps.now, newToken)
    : null

  const nonEditableService: NonEditableService | null = deps.nonEditable
    ? createNonEditableService(deps.nonEditable, deps.now, newToken)
    : null

  function nonEditable(): NonEditableService {
    if (!nonEditableService)
      throw new TranslateIpcError('TRANSLATE_FAILED', 'PDF translation is not available here')
    return nonEditableService
  }

  /** a listed source, its PDF kind resolved (scan detection) where that is available */
  async function sourceEntry(dir: string, file: string) {
    const project = await loadProject(dir)
    const listed = project.sources.find((s) => s.file === file)
    if (!listed) throw new TranslateIpcError('NOT_LISTED', 'this document is not in the project')
    const entry = nonEditableService ? await nonEditableService.resolveKind(dir, listed) : listed
    return { project, entry }
  }

  function ocr(): OcrService {
    if (!ocrService) throw new TranslateIpcError('OCR_FAILED', 'OCR is not available here')
    return ocrService
  }

  /** The stored spelling of `dir`, or a rejection when it is not a registered project. */
  function registeredDir(dir: unknown): string {
    if (typeof dir === 'string' && isAbsolute(dir)) {
      const entry = readTranslationProjects(deps.settingsPath()).find(
        (e) => fold(e.dir) === fold(dir),
      )
      if (entry) return entry.dir
    }
    throw new TranslateIpcError(
      'NOT_REGISTERED',
      'this folder is not a registered translation project',
    )
  }

  function viewDeps(): TranslationViewDeps {
    if (!deps.view) throw new TranslateIpcError('OPEN_FAILED', 'there is no window to open it in')
    return deps.view
  }

  /**
   * List a registered translation folder as a project folder once. An entry marked
   * `listed` is never listed again: the person may have removed it from the project
   * list since. A folder that could not be listed (refused, foreign content) stays
   * unmarked. Failures never fail the caller: the translation project works either way.
   * Answers whether the folder is (now or already) marked listed; true when there is
   * no project list here at all.
   */
  async function listOnce(dir: string): Promise<boolean> {
    const link = deps.projects
    if (!link) return true
    try {
      const path = deps.settingsPath()
      const entry = readTranslationProjects(path).find((e) => fold(e.dir) === fold(dir))
      if (!entry) return false
      if (entry.listed) return true
      if ((await link.ensureListed(dir)) === null) return false
      writeTranslationProjects(
        path,
        readTranslationProjects(path).map((e) =>
          fold(e.dir) === fold(dir) ? { ...e, listed: true as const } : e,
        ),
      )
      return true
    } catch {
      // the folder stays unlisted; the AI panels then carry no translation context
      return false
    }
  }

  /** a folder the person picked in the main-opened dialog, or null when cancelled */
  async function pickFolder(): Promise<string | null> {
    const res = await deps.showOpenDialog({ properties: ['openDirectory'] })
    const dir = res.filePaths[0]
    if (res.canceled || !dir || !isAbsolute(dir)) return null
    return dir
  }

  /**
   * Register a picked folder that already holds a translation project
   * (moved, copied, or made on another PC), replacing the entry `replacing`
   * when given. It is listed as a project folder through the same rules as a
   * new project (`listOnce`): a folder with AI instructions or memory from
   * elsewhere is not trusted here and stays off the project list.
   */
  async function adopt(picked: string, replacing?: string): Promise<TranslateAdoptedProject> {
    if ((await projectStatus(picked)) !== 'ok') throw new NotAProjectError(picked)
    const project = await loadProject(picked)
    const path = deps.settingsPath()
    const current = readTranslationProjects(path)
    const existing = current.find((e) => fold(e.dir) === fold(picked))
    const rest = current.filter(
      (e) =>
        fold(e.dir) !== fold(picked) &&
        (replacing === undefined || fold(e.dir) !== fold(replacing)),
    )
    // the same folder picked again keeps its entry (and its `listed` mark)
    writeTranslationProjects(path, [
      ...rest,
      existing ? { ...existing, lastOpened: deps.now() } : { dir: picked, lastOpened: deps.now() },
    ])
    if (replacing !== undefined && fold(replacing) !== fold(picked)) {
      try {
        await deps.projects?.unlist(replacing)
      } catch {
        // the old path stays on the project list; the person can remove it there
      }
    }
    const dir = existing?.dir ?? picked
    return { dir, name: project.name, contextLinked: await listOnce(dir) }
  }

  /** remember an opened document; an unwritable settings file must not fail the open */
  function noteRecent(dir: string, file: string, output: string): void {
    try {
      recordRecentDocument(deps.settingsPath(), { dir, file, output }, deps.now())
    } catch {
      // the open succeeded; only the recent list misses it
    }
  }

  function touch(dir: string): void {
    const path = deps.settingsPath()
    const projects = readTranslationProjects(path).map((e) =>
      fold(e.dir) === fold(dir) ? { ...e, lastOpened: deps.now() } : e,
    )
    writeTranslationProjects(path, projects)
  }

  return {
    async list(): Promise<TranslateProjectListEntry[]> {
      const out: TranslateProjectListEntry[] = []
      for (const entry of readTranslationProjects(deps.settingsPath())) {
        let status: TranslateProjectListEntry['status']
        let name = basename(entry.dir)
        let sourceLang = ''
        let targetLang = ''
        try {
          status = await projectStatus(entry.dir)
          if (status === 'ok') {
            const project = await loadProject(entry.dir)
            name = project.name
            sourceLang = project.sourceLang
            targetLang = project.targetLang
          }
        } catch {
          status = 'invalid'
        }
        out.push({
          dir: entry.dir,
          name,
          status,
          sourceLang,
          targetLang,
          lastOpened: entry.lastOpened,
        })
      }
      return out
    },

    async create(args: TranslateCreateArgs): Promise<{ dir: string }> {
      // only a folder the person picked in the dialog is accepted as the parent
      const parentToken = requireString(args?.parentToken, 'parentToken')
      const parentDir = parentPicks.path(parentToken, 0)
      if (!parentDir)
        throw new TranslateIpcError(
          'NOT_REGISTERED',
          'the parent folder was not picked (or the pick expired)',
        )
      const name = requireString(args.name, 'name')
      const sourceLang = requireString(args.sourceLang, 'sourceLang')
      const targetLang = requireString(args.targetLang, 'targetLang')
      const { dir } = await createProject(parentDir, name, sourceLang, targetLang)
      const path = deps.settingsPath()
      try {
        const rest = readTranslationProjects(path).filter((e) => fold(e.dir) !== fold(dir))
        writeTranslationProjects(path, [...rest, { dir, lastOpened: deps.now() }])
      } catch (err) {
        // the folder this call just made is not registered: remove it so a retry with the
        // same name does not meet PROJECT_EXISTS. Best effort; the first failure is reported.
        await rm(dir, { recursive: true, force: true }).catch(() => undefined)
        throw err
      }
      parentPicks.consume(parentToken, 0)
      // the app just made this folder at the person's request: list it as a project
      // folder so the AI panels carry its context
      await listOnce(dir)
      return { dir }
    },

    async remove(args: TranslateRemoveArgs): Promise<void> {
      const dir = registeredDir(args?.dir)
      // deleting under an open tab loses its unsaved edits, and a later save would make
      // files again in a half-deleted folder: the tabs are closed first
      if (args.deleteFolder === true && deps.isPathOpen?.(dir))
        throw new TranslateIpcError(
          'PROJECT_IN_USE',
          'documents of this project are open; close them before deleting the folder',
        )
      const dropEntry = () => {
        const path = deps.settingsPath()
        writeTranslationProjects(
          path,
          readTranslationProjects(path).filter((e) => fold(e.dir) !== fold(dir)),
        )
      }
      // the folder leaves the project list too, before it may be deleted (while its path
      // still resolves); its trust record stays, as with "Remove from list". A failure
      // there does not keep the translation entry.
      try {
        await deps.projects?.unlist(dir)
      } catch {
        // the project list keeps the folder; the person can remove it there
      }
      if (args.deleteFolder !== true) return dropEntry()
      // removeProject refuses a folder without a valid project file; that and
      // a vanished folder still drop the entry so it never gets stuck
      await withProjectLock(dir, async () => {
        try {
          await removeProject(dir, { deleteFolder: true })
        } catch (err) {
          if (!(err instanceof NotAProjectError)) {
            dropEntry()
            throw err
          }
        }
        dropEntry()
      })
    },

    async getSystemPrompt(): Promise<string> {
      return readTranslationSystemPrompt(deps.settingsPath())
    },

    async setSystemPrompt(text: string): Promise<void> {
      if (typeof text !== 'string')
        throw new TranslateIpcError('INVALID_ARGUMENT', 'the system prompt must be a string')
      writeTranslationSystemPrompt(deps.settingsPath(), text)
    },

    async getProject(dir: string): Promise<ProjectFile> {
      const registered = registeredDir(dir)
      const project = await loadProject(registered)
      try {
        touch(registered)
      } catch {
        // an unwritable settings file must not fail a read that succeeded
      }
      return project
    },

    async updateSettings(args: TranslateUpdateSettingsArgs): Promise<ProjectFile> {
      const dir = registeredDir(args?.dir)
      const patch: unknown = args.patch
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch))
        throw new TranslateIpcError('INVALID_ARGUMENT', 'patch must be an object')
      const keys = Object.keys(patch)
      const unknown = keys.find((k) => !SETTINGS_KEYS.includes(k))
      if (unknown) throw new TranslateIpcError('INVALID_ARGUMENT', `cannot change "${unknown}"`)
      const fields = patch as Record<string, unknown>
      for (const key of ['projectPrompt', 'sourceLang', 'targetLang']) {
        const v = fields[key]
        if (v === undefined) continue
        if (typeof v !== 'string' || (key !== 'projectPrompt' && v === ''))
          throw new TranslateIpcError('INVALID_ARGUMENT', `${key} is not valid`)
      }
      // read-modify-write under the project lock so a concurrent material change survives
      return withProjectLock(dir, async () => {
        const current = await loadProject(dir)
        const merged = { ...current }
        for (const key of keys) (merged as Record<string, unknown>)[key] = fields[key]
        let checked: ProjectFile
        try {
          // the same parser that reads project.json validates the new ocr value
          checked = parseProjectFile(JSON.stringify(merged))
        } catch {
          throw new TranslateIpcError('INVALID_ARGUMENT', 'the settings are not valid')
        }
        await saveProject(dir, checked)
        return checked
      })
    },

    async addMaterial(args: TranslateAddMaterialArgs): Promise<ProjectFile> {
      const dir = registeredDir(args?.dir)
      const kind = requireKind(args.kind)
      const token = requireString(args.token, 'token')
      // only a file the person picked, for this same kind, is ever copied
      const path =
        materialPicks.meta(token) === kind ? materialPicks.path(token, args.index) : undefined
      if (!path)
        throw new TranslateIpcError(
          'NOT_REGISTERED',
          'the file was not picked (or the pick expired or was already used)',
        )
      const info = await stat(path).catch(() => null)
      if (!info?.isFile())
        throw new TranslateIpcError('INVALID_ARGUMENT', 'the chosen file does not exist')
      const next =
        kind === 'source'
          ? await addSource(dir, path)
          : kind === 'reference'
            ? await addReference(dir, path, { convert })
            : await addGlossary(dir, path)
      materialPicks.consume(token, args.index)
      return next
    },

    async pickMaterials(kindArg: TranslateMaterialKind): Promise<TranslatePickedMaterials | null> {
      const kind = requireKind(kindArg)
      const res = await deps.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        filters: FILTERS[kind],
      })
      const paths = res.filePaths.filter((p) => isAbsolute(p))
      if (res.canceled || paths.length === 0) return null
      return { token: materialPicks.add(kind, paths), names: paths.map((p) => basename(p)) }
    },

    async pickParentDir(): Promise<TranslatePickedParentDir | null> {
      const res = await deps.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
      const dir = res.filePaths[0]
      if (res.canceled || !dir || !isAbsolute(dir)) return null
      return { token: parentPicks.add(null, [dir]), dir }
    },

    async openTranslation(
      args: TranslateOpenTranslationArgs,
    ): Promise<TranslateOpenTranslationResult> {
      const dir = registeredDir(args?.dir)
      const file = requireString(args.file, 'file')
      const view = viewDeps()
      // the source entry (and its hash) comes from project.json, never from the renderer;
      // a PDF is checked for a scan the first time (recorded in project.json)
      const { project, entry } = await sourceEntry(dir, file)
      // a project made before listing existed (or whose listing failed) is listed now, once
      await listOnce(dir)
      const result = await openTranslation(dir, entry, view, {
        ocr: project.ocr,
        targetLang: project.targetLang,
      })
      if (result.flow === 'edit') noteRecent(dir, entry.file, entry.file)
      return result
    },

    async openResult(args: TranslateOpenResultArgs): Promise<TranslateOpenResultAnswer> {
      const dir = registeredDir(args?.dir)
      const file = requireString(args.file, 'file')
      const view = viewDeps()
      const { project, entry } = await sourceEntry(dir, file)
      const answer = await openTranslationResult(dir, entry, args.output, view, project.targetLang)
      // openTranslationResult accepted `output`, so it is a plain file name here
      if (typeof args.output === 'string') noteRecent(dir, entry.file, args.output)
      return answer
    },

    async recent(): Promise<TranslateRecentDocument[]> {
      return listRecentDocuments(deps.settingsPath())
    },

    async setSourceKind(args: TranslateSetSourceKindArgs): Promise<ProjectFile> {
      const dir = registeredDir(args?.dir)
      return nonEditable().setKind(dir, args.file, args.kind)
    },

    async instructionsFor(args: TranslateInstructionsForArgs): Promise<TranslateInstructions> {
      const dir = registeredDir(args?.dir)
      const text = args.text
      if (typeof text !== 'string' || text.length > INSTRUCTIONS_TEXT_LIMIT)
        throw new TranslateIpcError('INVALID_ARGUMENT', 'the request text is not valid')
      const settingsPath = deps.settingsPath()
      const built = await buildTranslationInstructions(dir, text, {
        settingsPath,
        convertReference: convert,
      })
      const project = await loadProject(dir)
      const statuses = await referenceStatuses(dir).catch(() => ({}) as Record<string, string>)
      return {
        prompts: built.promptText,
        material: built.materialText,
        references: built.referencesText,
        summary: {
          systemPrompt: readTranslationSystemPrompt(settingsPath).trim() !== '',
          projectPrompt: project.projectPrompt.trim() !== '',
          glossaryTotal: built.glossaryTotal,
          glossaryLimit: DEFAULT_GLOSSARY_LIMIT,
          referenceNames: [...project.references],
          referenceConverted: project.references.filter((r) => statuses[r] === 'converted').length,
        },
      }
    },

    async referenceStatus(dirArg: string): Promise<Record<string, TranslateReferenceStatus>> {
      const dir = registeredDir(dirArg)
      return refreshReferences(dir, convert)
    },

    async referenceText(args: TranslateReferenceTextArgs): Promise<TranslateReferenceText> {
      const dir = registeredDir(args?.dir)
      const file = requireString(args.file, 'file')
      const project = await loadProject(dir)
      const text = project.references.includes(file)
        ? await readConvertedReference(dir, file)
        : null
      if (text === null)
        throw new TranslateIpcError('NOT_LISTED', 'this reference has no converted text')
      const truncated = text.length > REFERENCE_VIEW_MAX_CHARS
      return { text: truncated ? text.slice(0, REFERENCE_VIEW_MAX_CHARS) : text, truncated }
    },

    async pickExisting(): Promise<TranslateAdoptedProject | null> {
      const picked = await pickFolder()
      return picked === null ? null : adopt(picked)
    },

    async relocate(args: TranslateRelocateArgs): Promise<TranslateAdoptedProject | null> {
      const dir = registeredDir(args?.dir)
      const picked = await pickFolder()
      return picked === null ? null : adopt(picked, dir)
    },

    /** `owner`: the webContents id that asks; its translations end when it goes */
    async pdfPrepare(args: TranslatePdfPrepareArgs, owner?: number) {
      const service = nonEditable()
      const dir = registeredDir(args?.dir)
      return service.pdfPrepare(dir, args.file, owner)
    },

    async pdfStore(args: TranslatePdfStoreArgs) {
      return nonEditable().pdfStore(args?.token, args?.request)
    },

    async pdfWrite(args: TranslatePdfWriteArgs) {
      return nonEditable().pdfWrite(args?.token, args?.bilingual)
    },

    async pdfRelease(token: string): Promise<void> {
      return nonEditable().pdfRelease(token)
    },

    async setPaneHidden(args: TranslateSetPaneHiddenArgs): Promise<void> {
      const side = args?.side
      if (side !== 'left' && side !== 'right')
        throw new TranslateIpcError('INVALID_ARGUMENT', 'side must be left or right')
      if (typeof args.hidden !== 'boolean')
        throw new TranslateIpcError('INVALID_ARGUMENT', 'hidden must be true or false')
      if (!viewDeps().setPaneHidden(side, args.hidden))
        throw new TranslateIpcError('INVALID_ARGUMENT', 'no translation view is shown')
    },

    /** `owner`: the webContents id that asks; its listings end when it goes (ocrForgetOwner) */
    async ocrPrepare(args: TranslateOcrPrepareArgs, owner?: number) {
      const service = ocr()
      const dir = registeredDir(args?.dir)
      return service.prepare(dir, args.files, owner)
    },

    async ocrForgetOwner(owner: number): Promise<void> {
      ocrService?.forgetOwner(owner)
      nonEditableService?.forgetOwner(owner)
    },

    async ocrStart(args: TranslateOcrStartArgs): Promise<void> {
      return ocr().start(args?.token, args?.pages)
    },

    async ocrPageImage(args: TranslateOcrPageImageArgs) {
      return ocr().pageImage(args?.token, args?.index)
    },

    async ocrWrite(args: TranslateOcrWriteArgs) {
      return ocr().write(args?.token, args?.pages)
    },

    async ocrRelease(token: string): Promise<void> {
      return ocr().release(token)
    },

    async removeMaterial(args: TranslateRemoveMaterialArgs): Promise<ProjectFile> {
      const dir = registeredDir(args?.dir)
      const kind = requireKind(args.kind)
      const file = requireString(args.file, 'file')
      if (kind === 'source') return removeSource(dir, file)
      if (kind === 'reference') return removeReference(dir, file, { convert })
      return removeGlossary(dir, file)
    },
  }
}

/** the part of a webContents the OCR channels watch */
export interface OcrSender {
  id: number
  once(event: 'destroyed', listener: () => void): unknown
  on(event: 'render-process-gone', listener: () => void): unknown
}

/** the part of an IPC event the sender check reads */
interface TranslateIpcEvent {
  sender: unknown
}

/**
 * Register the `translate:` channels. Every channel answers only the shell
 * window (the home screen, its translation dialogs and the tab strip, as the
 * `mcp-servers:*` settings channels do): `isShellSender` is false for an
 * editor tab, the manual tab or any other window, and the call is refused
 * before the handler runs.
 */
export function registerTranslateIpc(
  ipc: Pick<IpcMain, 'handle'>,
  deps: TranslateIpcDeps,
  isShellSender: (sender: unknown) => boolean,
): void {
  const h = createTranslateHandlers(deps)
  const handle = (
    channel: string,
    answer: (event: TranslateIpcEvent, ...args: never[]) => unknown,
  ): void => {
    ipc.handle(channel, (event, ...args: unknown[]) => {
      if (!isShellSender(event.sender))
        return Promise.reject(
          new TranslateIpcError('INVALID_ARGUMENT', 'this window cannot use the translation tool'),
        )
      return answer(event, ...(args as never[]))
    })
  }
  // an OCR listing or run belongs to the window that made it: closing or crashing that
  // window ends it at once instead of after the idle expiry
  const watched = new Set<number>()
  const watchOcrSender = (sender: OcrSender): number => {
    const id = sender.id
    if (!watched.has(id)) {
      watched.add(id)
      sender.once('destroyed', () => {
        watched.delete(id)
        void h.ocrForgetOwner(id)
      })
      sender.on('render-process-gone', () => void h.ocrForgetOwner(id))
    }
    return id
  }
  handle(TRANSLATE_CHANNELS.list, () => h.list())
  handle(TRANSLATE_CHANNELS.recent, () => h.recent())
  handle(TRANSLATE_CHANNELS.create, (_e, args: TranslateCreateArgs) => h.create(args))
  handle(TRANSLATE_CHANNELS.remove, (_e, args: TranslateRemoveArgs) => h.remove(args))
  handle(TRANSLATE_CHANNELS.getSystemPrompt, () => h.getSystemPrompt())
  handle(TRANSLATE_CHANNELS.setSystemPrompt, (_e, text: string) => h.setSystemPrompt(text))
  handle(TRANSLATE_CHANNELS.getProject, (_e, dir: string) => h.getProject(dir))
  handle(TRANSLATE_CHANNELS.updateSettings, (_e, args: TranslateUpdateSettingsArgs) =>
    h.updateSettings(args),
  )
  handle(TRANSLATE_CHANNELS.addMaterial, (_e, args: TranslateAddMaterialArgs) =>
    h.addMaterial(args),
  )
  handle(TRANSLATE_CHANNELS.removeMaterial, (_e, args: TranslateRemoveMaterialArgs) =>
    h.removeMaterial(args),
  )
  handle(TRANSLATE_CHANNELS.pickMaterials, (_e, kind: TranslateMaterialKind) =>
    h.pickMaterials(kind),
  )
  handle(TRANSLATE_CHANNELS.pickParentDir, () => h.pickParentDir())
  handle(TRANSLATE_CHANNELS.openTranslation, (_e, args: TranslateOpenTranslationArgs) =>
    h.openTranslation(args),
  )
  handle(TRANSLATE_CHANNELS.setPaneHidden, (_e, args: TranslateSetPaneHiddenArgs) =>
    h.setPaneHidden(args),
  )
  handle(TRANSLATE_CHANNELS.ocrPrepare, (e, args: TranslateOcrPrepareArgs) =>
    h.ocrPrepare(args, watchOcrSender(e.sender as unknown as OcrSender)),
  )
  handle(TRANSLATE_CHANNELS.ocrStart, (_e, args: TranslateOcrStartArgs) => h.ocrStart(args))
  handle(TRANSLATE_CHANNELS.ocrPageImage, (_e, args: TranslateOcrPageImageArgs) =>
    h.ocrPageImage(args),
  )
  handle(TRANSLATE_CHANNELS.ocrWrite, (_e, args: TranslateOcrWriteArgs) => h.ocrWrite(args))
  handle(TRANSLATE_CHANNELS.ocrRelease, (_e, token: string) => h.ocrRelease(token))
  handle(TRANSLATE_CHANNELS.instructionsFor, (_e, args: TranslateInstructionsForArgs) =>
    h.instructionsFor(args),
  )
  handle(TRANSLATE_CHANNELS.pdfPrepare, (e, args: TranslatePdfPrepareArgs) =>
    h.pdfPrepare(args, watchOcrSender(e.sender as unknown as OcrSender)),
  )
  handle(TRANSLATE_CHANNELS.pdfStore, (_e, args: TranslatePdfStoreArgs) => h.pdfStore(args))
  handle(TRANSLATE_CHANNELS.pdfWrite, (_e, args: TranslatePdfWriteArgs) => h.pdfWrite(args))
  handle(TRANSLATE_CHANNELS.pdfRelease, (_e, token: string) => h.pdfRelease(token))
  handle(TRANSLATE_CHANNELS.openResult, (_e, args: TranslateOpenResultArgs) => h.openResult(args))
  handle(TRANSLATE_CHANNELS.setSourceKind, (_e, args: TranslateSetSourceKindArgs) =>
    h.setSourceKind(args),
  )
  handle(TRANSLATE_CHANNELS.pickExisting, () => h.pickExisting())
  handle(TRANSLATE_CHANNELS.relocate, (_e, args: TranslateRelocateArgs) => h.relocate(args))
  handle(TRANSLATE_CHANNELS.referenceStatus, (_e, dir: string) => h.referenceStatus(dir))
  handle(TRANSLATE_CHANNELS.referenceText, (_e, args: TranslateReferenceTextArgs) =>
    h.referenceText(args),
  )
}
