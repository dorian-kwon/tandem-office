import { stat } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { loadProject } from '@genoffice/translate-project'
import { readAppSettings, readTranslationProjects, writeAppSetting } from '../app-settings'
import type { TranslateRecentDocument } from '../../shared/translate-api'

/** `translationRecentDocuments`: documents opened in the translation view, newest first */
export const RECENT_DOCUMENTS_KEY = 'translationRecentDocuments'
/** the most entries kept and shown */
export const RECENT_DOCUMENTS_LIMIT = 10

/** what is stored per entry (never in project.json) */
interface StoredRecent {
  dir: string
  /** the project's source file name (what the open path takes) */
  file: string
  /** the file name in output/ that was opened */
  output: string
  openedAt: number
}

function fold(path: string): string {
  const full = resolve(path)
  return process.platform === 'win32' ? full.toLowerCase() : full
}

function plainName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name !== '' &&
    name !== '.' &&
    name !== '..' &&
    basename(name) === name &&
    !/[\\/]/.test(name)
  )
}

function sameDoc(a: StoredRecent, b: StoredRecent): boolean {
  return fold(a.dir) === fold(b.dir) && a.file === b.file
}

/** The stored value read back: bad entries are dropped, newest first, one per project+file, capped. */
function normalize(raw: unknown): StoredRecent[] {
  const valid: StoredRecent[] = []
  for (const item of Array.isArray(raw) ? raw : []) {
    if (typeof item !== 'object' || item === null) continue
    const e = item as Record<string, unknown>
    if (typeof e.dir !== 'string' || !isAbsolute(e.dir)) continue
    if (!plainName(e.file) || !plainName(e.output)) continue
    const at = e.openedAt
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) continue
    valid.push({ dir: e.dir, file: e.file, output: e.output, openedAt: at })
  }
  // newest first, then keep the newest of each project+file
  valid.sort((x, y) => y.openedAt - x.openedAt)
  const out: StoredRecent[] = []
  for (const entry of valid) if (!out.some((o) => sameDoc(o, entry))) out.push(entry)
  return out.slice(0, RECENT_DOCUMENTS_LIMIT)
}

/** Note that a document was opened in the translation view (app settings file only). */
export function recordRecentDocument(
  settingsPath: string,
  doc: { dir: string; file: string; output: string },
  now: number,
): void {
  const entry: StoredRecent = { ...doc, openedAt: now }
  const current = normalize(readAppSettings(settingsPath)[RECENT_DOCUMENTS_KEY])
  const registered = new Set(readTranslationProjects(settingsPath).map((p) => fold(p.dir)))
  const next = normalize([entry, ...current.filter((e) => !sameDoc(e, entry))]).filter((e) =>
    registered.has(fold(e.dir)),
  )
  writeAppSetting(settingsPath, RECENT_DOCUMENTS_KEY, next)
}

/** Drop one project+file entry from the list; nothing on disk changes. */
export function forgetRecentDocument(
  settingsPath: string,
  doc: { dir: string; file: string },
): void {
  const probe: StoredRecent = { ...doc, output: '', openedAt: 0 }
  const current = normalize(readAppSettings(settingsPath)[RECENT_DOCUMENTS_KEY])
  const next = current.filter((e) => !sameDoc(e, probe))
  if (next.length !== current.length) writeAppSetting(settingsPath, RECENT_DOCUMENTS_KEY, next)
}

/** The recent documents of projects still registered, newest first, at most 10. */
export async function listRecentDocuments(
  settingsPath: string,
): Promise<TranslateRecentDocument[]> {
  const registered = new Map(
    readTranslationProjects(settingsPath).map((p) => [fold(p.dir), p.dir] as const),
  )
  const out: TranslateRecentDocument[] = []
  for (const e of normalize(readAppSettings(settingsPath)[RECENT_DOCUMENTS_KEY])) {
    const dir = registered.get(fold(e.dir))
    if (dir === undefined) continue
    let projectName = basename(dir)
    let sourceLang = ''
    let targetLang = ''
    let available = false
    try {
      const project = await loadProject(dir)
      projectName = project.name
      sourceLang = project.sourceLang
      targetLang = project.targetLang
      // what the click does: open the project's source entry `file` through the normal path
      // the original may be gone while the translation is left: the open then offers to use it
      const isFile = async (path: string) => (await stat(path).catch(() => null))?.isFile() === true
      available =
        project.sources.some((src) => src.file === e.file) &&
        ((await isFile(join(dir, 'source', e.file))) || (await isFile(join(dir, 'output', e.output))))
    } catch {
      // the folder or the project file is gone: shown, but not openable
    }
    out.push({
      dir,
      projectName,
      file: e.file,
      sourceLang,
      targetLang,
      openedAt: e.openedAt,
      available,
    })
  }
  return out
}
