import { isAbsolute, relative, resolve, sep } from 'node:path'
import { loadProject } from '@genoffice/translate-project'
import { readTranslationProjects } from '../app-settings'

/** the language pair of the translation project a document belongs to */
export interface TranslationLanguages {
  sourceLang: string
  targetLang: string
}

function fold(path: string): string {
  const full = resolve(path)
  return process.platform === 'win32' ? full.toLowerCase() : full
}

/** true when `file` sits inside the project's source/ or output/ folder */
function insideProjectFolders(dir: string, file: string): boolean {
  const rel = relative(fold(dir), fold(file))
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false
  const top = rel.split(sep)[0]
  return top === 'source' || top === 'output'
}

/**
 * The language pair of the registered translation project whose source/ or output/ folder holds
 * `filePath`, or null when the file belongs to no project (or the project cannot be read).
 * The editors use it to aim a web translation at the project's target language.
 */
export async function translationLanguagesOfFile(
  settingsPath: string,
  filePath: string | undefined,
): Promise<TranslationLanguages | null> {
  if (!filePath || !isAbsolute(filePath)) return null
  for (const entry of readTranslationProjects(settingsPath)) {
    if (!insideProjectFolders(entry.dir, filePath)) continue
    try {
      const project = await loadProject(entry.dir)
      return { sourceLang: project.sourceLang, targetLang: project.targetLang }
    } catch {
      return null
    }
  }
  return null
}
