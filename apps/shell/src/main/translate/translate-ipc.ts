import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import type { IpcMain } from 'electron'
import {
  addGlossary,
  addReference,
  addSource,
  createProject,
  loadProject,
  NotAProjectError,
  parseProjectFile,
  projectStatus,
  removeGlossary,
  removeProject,
  removeReference,
  removeSource,
  saveProject,
  withProjectLock,
  type ProjectFile,
} from '@genoffice/translate-project'
import { PickAllowlist } from './pick-allowlist'
import { createOcrService, type OcrService, type OcrServiceDeps } from './ocr'
import { openTranslation, type TranslationViewDeps } from './open-translation'
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
  type TranslateCreateArgs,
  type TranslateMaterialKind,
  type TranslateOcrPageImageArgs,
  type TranslateOcrPrepareArgs,
  type TranslateOcrStartArgs,
  type TranslateOcrWriteArgs,
  type TranslateOpenTranslationArgs,
  type TranslateOpenTranslationResult,
  type TranslatePickedMaterials,
  type TranslatePickedParentDir,
  type TranslateProjectListEntry,
  type TranslateRemoveArgs,
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
}

export interface OpenDialogOptions {
  title?: string
  properties: ('openFile' | 'openDirectory' | 'multiSelections' | 'createDirectory')[]
  filters?: { name: string; extensions: string[] }[]
}

const FILTERS: Record<TranslateMaterialKind, { name: string; extensions: string[] }[]> = {
  source: [
    {
      name: 'Documents',
      extensions: [
        'docx',
        'xlsx',
        'pptx',
        'hwp',
        'hwpx',
        'epub',
        'md',
        'markdown',
        'txt',
        'html',
        'htm',
        'odt',
        'ods',
        'odp',
        'pdf',
        'png',
        'jpg',
        'jpeg',
        'gif',
        'bmp',
        'tif',
        'tiff',
        'webp',
      ],
    },
  ],
  reference: [{ name: 'All files', extensions: ['*'] }],
  glossary: [{ name: 'Glossary', extensions: ['csv', 'tsv', 'txt', 'xlsx'] }],
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
  const ocrService: OcrService | null = deps.ocr
    ? createOcrService(deps.ocr, deps.now, newToken)
    : null

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
   */
  async function listOnce(dir: string): Promise<void> {
    const link = deps.projects
    if (!link) return
    try {
      const path = deps.settingsPath()
      const entry = readTranslationProjects(path).find((e) => fold(e.dir) === fold(dir))
      if (!entry || entry.listed) return
      if ((await link.ensureListed(dir)) === null) return
      writeTranslationProjects(
        path,
        readTranslationProjects(path).map((e) =>
          fold(e.dir) === fold(dir) ? { ...e, listed: true as const } : e,
        ),
      )
    } catch {
      // the folder stays unlisted; the AI panels then carry no translation context
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
      const rest = readTranslationProjects(path).filter((e) => fold(e.dir) !== fold(dir))
      writeTranslationProjects(path, [...rest, { dir, lastOpened: deps.now() }])
      parentPicks.consume(parentToken, 0)
      // the app just made this folder at the person's request: list it as a project
      // folder so the AI panels carry its context
      await listOnce(dir)
      return { dir }
    },

    async remove(args: TranslateRemoveArgs): Promise<void> {
      const dir = registeredDir(args?.dir)
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
            ? await addReference(dir, path)
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
      // the source entry (and its hash) comes from project.json, never from the renderer
      const project = await loadProject(dir)
      const entry = project.sources.find((s) => s.file === file)
      if (!entry) throw new TranslateIpcError('NOT_LISTED', 'this document is not in the project')
      // a project made before listing existed (or whose listing failed) is listed now, once
      await listOnce(dir)
      return openTranslation(dir, entry, view)
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

    async ocrPrepare(args: TranslateOcrPrepareArgs) {
      const service = ocr()
      const dir = registeredDir(args?.dir)
      return service.prepare(dir, args.files)
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
      if (kind === 'reference') return removeReference(dir, file)
      return removeGlossary(dir, file)
    },
  }
}

export function registerTranslateIpc(ipc: Pick<IpcMain, 'handle'>, deps: TranslateIpcDeps): void {
  const h = createTranslateHandlers(deps)
  ipc.handle(TRANSLATE_CHANNELS.list, () => h.list())
  ipc.handle(TRANSLATE_CHANNELS.create, (_e, args: TranslateCreateArgs) => h.create(args))
  ipc.handle(TRANSLATE_CHANNELS.remove, (_e, args: TranslateRemoveArgs) => h.remove(args))
  ipc.handle(TRANSLATE_CHANNELS.getSystemPrompt, () => h.getSystemPrompt())
  ipc.handle(TRANSLATE_CHANNELS.setSystemPrompt, (_e, text: string) => h.setSystemPrompt(text))
  ipc.handle(TRANSLATE_CHANNELS.getProject, (_e, dir: string) => h.getProject(dir))
  ipc.handle(TRANSLATE_CHANNELS.updateSettings, (_e, args: TranslateUpdateSettingsArgs) =>
    h.updateSettings(args),
  )
  ipc.handle(TRANSLATE_CHANNELS.addMaterial, (_e, args: TranslateAddMaterialArgs) =>
    h.addMaterial(args),
  )
  ipc.handle(TRANSLATE_CHANNELS.removeMaterial, (_e, args: TranslateRemoveMaterialArgs) =>
    h.removeMaterial(args),
  )
  ipc.handle(TRANSLATE_CHANNELS.pickMaterials, (_e, kind: TranslateMaterialKind) =>
    h.pickMaterials(kind),
  )
  ipc.handle(TRANSLATE_CHANNELS.pickParentDir, () => h.pickParentDir())
  ipc.handle(TRANSLATE_CHANNELS.openTranslation, (_e, args: TranslateOpenTranslationArgs) =>
    h.openTranslation(args),
  )
  ipc.handle(TRANSLATE_CHANNELS.setPaneHidden, (_e, args: TranslateSetPaneHiddenArgs) =>
    h.setPaneHidden(args),
  )
  ipc.handle(TRANSLATE_CHANNELS.ocrPrepare, (_e, args: TranslateOcrPrepareArgs) =>
    h.ocrPrepare(args),
  )
  ipc.handle(TRANSLATE_CHANNELS.ocrStart, (_e, args: TranslateOcrStartArgs) => h.ocrStart(args))
  ipc.handle(TRANSLATE_CHANNELS.ocrPageImage, (_e, args: TranslateOcrPageImageArgs) =>
    h.ocrPageImage(args),
  )
  ipc.handle(TRANSLATE_CHANNELS.ocrWrite, (_e, args: TranslateOcrWriteArgs) => h.ocrWrite(args))
  ipc.handle(TRANSLATE_CHANNELS.ocrRelease, (_e, token: string) => h.ocrRelease(token))
}
