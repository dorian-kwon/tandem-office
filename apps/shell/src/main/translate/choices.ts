import { isAbsolute, resolve } from 'node:path'
import {
  loadProject,
  saveProject,
  TRANSLATION_CHOICE_KEYS,
  withChoice,
  withProjectLock,
  type TranslationChoiceKey,
} from '@genoffice/translate-project'
import type { RememberChoiceResult } from '@genoffice/project-store/folder-api'
import { readTranslationProjects } from '../app-settings'

/**
 * An editor's AI panel keeps one answer of its numbered question card ("use this for the
 * rest of the project") in the translation project's `project.json`. Main decides which
 * project: the caller passes the folder of the project the window's panel has chosen, and
 * only a registered translation project accepts a write. Nothing here logs: the value is the
 * person's own wording.
 */
export async function rememberTranslationChoice(
  settingsPath: string,
  root: string,
  key: string,
  value: string,
): Promise<RememberChoiceResult> {
  if (!(TRANSLATION_CHOICE_KEYS as readonly string[]).includes(key)) {
    return { ok: false, reason: 'invalid' }
  }
  if (typeof value !== 'string' || value.trim() === '') return { ok: false, reason: 'invalid' }
  if (!isAbsolute(root)) return { ok: false, reason: 'not-translation' }
  const fold = (path: string): string =>
    process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
  const entry = readTranslationProjects(settingsPath).find((e) => fold(e.dir) === fold(root))
  if (!entry) return { ok: false, reason: 'not-translation' }
  try {
    await withProjectLock(entry.dir, async () => {
      const current = await loadProject(entry.dir)
      await saveProject(entry.dir, withChoice(current, key as TranslationChoiceKey, value))
    })
    return { ok: true }
  } catch {
    return { ok: false, reason: 'failed' }
  }
}
