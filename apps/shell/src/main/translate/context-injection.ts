import {
  composeContext,
  DEFAULT_GLOSSARY_LIMIT,
  loadGlossary,
  loadProject,
  projectStatus,
  selectGlossary,
  type ComposedContext,
  type GlossaryEntry,
  type ProjectFile,
} from '@genoffice/translate-project'
import type { ProjectTranslationItem } from '@genoffice/project-store'
import { readTranslationProjects, readTranslationSystemPrompt } from '../app-settings'
import { INSTRUCTIONS_LIMIT_CHARS } from '../projects/context'
import { canonicalPath, samePath } from '../projects/paths'

/**
 * The translation project's context for the editors' AI panels (spec 6.6). A
 * translation project folder is also a project folder (decision 0088), so the
 * panel already sends that project's context with each request; the project
 * guide asks `translationContextForFolder` for the extra translation part.
 *
 * Nothing here logs: prompts and glossary entries are the person's material.
 */

export interface TranslationContextOptions {
  /** `<userData>/app-settings.json`: the global system prompt and the registered list */
  settingsPath: string
  /** the text never gets longer than this; default INSTRUCTIONS_LIMIT_CHARS (32,000) */
  limitChars?: number
  platform?: NodeJS.Platform
}

export interface TranslationInstructions extends ComposedContext {
  /** glossary entries in the text */
  glossaryIncluded: number
  /** entries in the project's glossary */
  glossaryTotal: number
  /** reference file names in the text */
  referenceCount: number
  /** the prompts alone were over the limit: the text was cut and holds no glossary entry */
  cut: boolean
}

/** `text` cut to `limit` characters without splitting a surrogate pair */
function cutAt(text: string, limit: number): string {
  if (text.length <= limit) return text
  let end = limit
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return text.slice(0, end)
}

/**
 * The context one AI request carries for the translation project in `dir`:
 * the global system prompt (app settings), the project prompt with the
 * language pair, glossary entries and reference file names, as
 * `composeContext` writes them.
 *
 * Glossary entries:
 * - with request text (`paragraph`), `selectGlossary` picks them: the whole
 *   glossary up to DEFAULT_GLOSSARY_LIMIT entries, else the entries whose
 *   source term appears in the text;
 * - without request text nothing can be matched, so the glossary is taken in
 *   file order, at most DEFAULT_GLOSSARY_LIMIT entries.
 * Over `limitChars`, whole entries are dropped from the end until the text
 * fits; if the prompts alone are over it, the text is cut there (`cut`).
 */
export async function buildTranslationInstructions(
  dir: string,
  paragraph: string,
  options: TranslationContextOptions,
): Promise<TranslationInstructions> {
  const project = await loadProject(dir)
  const glossary = await loadGlossary(dir)
  const systemPrompt = readTranslationSystemPrompt(options.settingsPath)
  const limit = options.limitChars ?? INSTRUCTIONS_LIMIT_CHARS
  const candidates =
    paragraph.trim() === ''
      ? glossary.slice(0, DEFAULT_GLOSSARY_LIMIT)
      : selectGlossary(glossary, paragraph, DEFAULT_GLOSSARY_LIMIT)
  return fitted(systemPrompt, project, candidates, glossary.length, limit)
}

function fitted(
  systemPrompt: string,
  project: ProjectFile,
  candidates: GlossaryEntry[],
  total: number,
  limit: number,
): TranslationInstructions {
  // `candidates` is already the selection: composeContext keeps every one of them
  const compose = (count: number) =>
    composeContext({
      systemPrompt,
      project,
      glossary: candidates.slice(0, count),
      paragraph: '',
      glossaryLimit: count,
    })
  const result = (composed: ComposedContext, count: number, cut: boolean) => ({
    ...composed,
    glossaryIncluded: count,
    glossaryTotal: total,
    referenceCount: project.references.length,
    cut,
  })
  const all = compose(candidates.length)
  if (all.text.length <= limit) return result(all, candidates.length, false)
  // the text grows with each entry: find the most entries that still fit
  let low = 0
  let high = candidates.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (compose(mid).text.length <= limit) low = mid
    else high = mid - 1
  }
  const best = compose(low)
  if (best.text.length <= limit) return result(best, low, false)
  return result({ ...best, text: cutAt(best.text, limit) }, 0, true)
}

/** What the project guide adds to a translation project's context */
export interface TranslationFolderContext {
  text: string
  items: ProjectTranslationItem[]
  cut: boolean
}

/** The registered translation project at `root` (any spelling of the path), or undefined */
function registeredDir(root: string, options: TranslationContextOptions): string | undefined {
  const platform = options.platform ?? process.platform
  const key = canonicalPath(root)
  return readTranslationProjects(options.settingsPath).find((entry) =>
    samePath(canonicalPath(entry.dir), key, platform),
  )?.dir
}

/**
 * The translation context of a project folder, or null when the folder is not
 * a registered translation project (an ordinary project folder) or its
 * project file cannot be read. The panel's request text does not reach the
 * project guide, so the glossary goes without per-request selection (see
 * `buildTranslationInstructions` with an empty paragraph).
 */
export async function translationContextForFolder(
  root: string,
  options: TranslationContextOptions,
): Promise<TranslationFolderContext | null> {
  const dir = registeredDir(root, options)
  if (dir === undefined) return null
  if ((await projectStatus(dir)) !== 'ok') return null
  let built: TranslationInstructions
  try {
    built = await buildTranslationInstructions(dir, '', options)
  } catch {
    // a broken glossary or project file sends nothing of the translation tool
    return null
  }
  const included = (kind: ProjectTranslationItem['kind']) =>
    built.items.find((item) => item.kind === kind)?.included ?? false
  return {
    text: built.text,
    cut: built.cut,
    items: [
      { kind: 'system', included: included('system') },
      { kind: 'project', included: included('project') },
      {
        kind: 'glossary',
        included: built.glossaryIncluded > 0,
        count: built.glossaryIncluded,
        total: built.glossaryTotal,
      },
      {
        kind: 'reference',
        included: included('reference'),
        count: built.referenceCount,
      },
    ],
  }
}
