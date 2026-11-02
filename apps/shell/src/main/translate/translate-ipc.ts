import { stat } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import type { IpcMain } from 'electron'
import {
  addGlossary,
  addReference,
  addSource,
  createProject,
  loadProject,
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
import {
  readTranslationProjects,
  readTranslationSystemPrompt,
  writeTranslationProjects,
  writeTranslationSystemPrompt,
} from '../app-settings'
import {
  TRANSLATE_CHANNELS,
  type TranslateAddMaterialArgs,
  type TranslateCreateArgs,
  type TranslateMaterialKind,
  type TranslateProjectListEntry,
  type TranslateRemoveArgs,
  type TranslateRemoveMaterialArgs,
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
}

const KINDS: readonly TranslateMaterialKind[] = ['source', 'reference', 'glossary']

function fold(path: string): string {
  const full = resolve(path)
  return process.platform === 'win32' ? full.toLowerCase() : full
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '')
    throw new Error(`${what} must be a non-empty string`)
  return value
}

function requireKind(value: unknown): TranslateMaterialKind {
  const kind = KINDS.find((k) => k === value)
  if (!kind) throw new Error('unknown material kind')
  return kind
}

export function createTranslateHandlers(deps: TranslateIpcDeps) {
  /** The stored spelling of `dir`, or a rejection when it is not a registered project. */
  function registeredDir(dir: unknown): string {
    if (typeof dir === 'string' && isAbsolute(dir)) {
      const entry = readTranslationProjects(deps.settingsPath()).find(
        (e) => fold(e.dir) === fold(dir),
      )
      if (entry) return entry.dir
    }
    throw new Error('this folder is not a registered translation project')
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
      const parentDir = requireString(args?.parentDir, 'parentDir')
      if (!isAbsolute(parentDir)) throw new Error('parentDir must be an absolute path')
      const name = requireString(args.name, 'name')
      const sourceLang = requireString(args.sourceLang, 'sourceLang')
      const targetLang = requireString(args.targetLang, 'targetLang')
      const { dir } = await createProject(parentDir, name, sourceLang, targetLang)
      const path = deps.settingsPath()
      const rest = readTranslationProjects(path).filter((e) => fold(e.dir) !== fold(dir))
      writeTranslationProjects(path, [...rest, { dir, lastOpened: deps.now() }])
      return { dir }
    },

    async remove(args: TranslateRemoveArgs): Promise<void> {
      const dir = registeredDir(args?.dir)
      // removeProject has its own check that the folder holds a valid project
      if (args.deleteFolder === true) await removeProject(dir, { deleteFolder: true })
      const path = deps.settingsPath()
      writeTranslationProjects(
        path,
        readTranslationProjects(path).filter((e) => fold(e.dir) !== fold(dir)),
      )
    },

    async getSystemPrompt(): Promise<string> {
      return readTranslationSystemPrompt(deps.settingsPath())
    },

    async setSystemPrompt(text: string): Promise<void> {
      if (typeof text !== 'string') throw new Error('the system prompt must be a string')
      writeTranslationSystemPrompt(deps.settingsPath(), text)
    },

    async getProject(dir: string): Promise<ProjectFile> {
      const registered = registeredDir(dir)
      const project = await loadProject(registered)
      touch(registered)
      return project
    },

    async saveProject(dir: string, project: ProjectFile): Promise<void> {
      const registered = registeredDir(dir)
      // the renderer's object is checked by the same parser that reads project.json
      const checked = parseProjectFile(JSON.stringify(project))
      await withProjectLock(registered, () => saveProject(registered, checked))
    },

    async addMaterial(args: TranslateAddMaterialArgs): Promise<ProjectFile> {
      const dir = registeredDir(args?.dir)
      const kind = requireKind(args.kind)
      const path = requireString(args.path, 'path')
      if (!isAbsolute(path)) throw new Error('path must be an absolute path')
      const info = await stat(path).catch(() => null)
      if (!info?.isFile()) throw new Error('the chosen file does not exist')
      if (kind === 'source') return addSource(dir, path)
      if (kind === 'reference') return addReference(dir, path)
      return addGlossary(dir, path)
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
  ipc.handle(TRANSLATE_CHANNELS.saveProject, (_e, dir: string, project: ProjectFile) =>
    h.saveProject(dir, project),
  )
  ipc.handle(TRANSLATE_CHANNELS.addMaterial, (_e, args: TranslateAddMaterialArgs) =>
    h.addMaterial(args),
  )
  ipc.handle(TRANSLATE_CHANNELS.removeMaterial, (_e, args: TranslateRemoveMaterialArgs) =>
    h.removeMaterial(args),
  )
}
