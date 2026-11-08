import {
  composeContext,
  DEFAULT_GLOSSARY_LIMIT,
  DEFAULT_REFERENCE_CHARS,
  loadGlossary,
  loadProject,
  projectStatus,
  queryReferences,
  selectGlossary,
  type ComposedContext,
  type GlossaryEntry,
  type ProjectFile,
  type ReferenceChunk,
  type ReferenceConverter,
} from '@genoffice/translate-project'
import { convertReference } from './reference-convert'
import type { ProjectTranslationItem } from '@genoffice/project-store'
import { readTranslationProjects, readTranslationSystemPrompt } from '../app-settings'
import { INSTRUCTIONS_LIMIT_CHARS } from '../projects/context'
import { canonicalPath, samePath } from '../projects/paths'
import {
  fixedContextHash,
  fixedContextMarker,
  type FixedContextConversation,
  type FixedContextLedger,
} from './fixed-context'

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
  /**
   * the text and the reference chunks together never get longer than this;
   * default INSTRUCTIONS_LIMIT_CHARS (32,000)
   */
  limitChars?: number
  platform?: NodeJS.Platform
  /**
   * converts a reference again when the index lags the folder (edited in
   * place, or a project from before the index); default file-parse's reader
   */
  convertReference?: ReferenceConverter
  /**
   * which conversations already carry the fixed part (fixed-context.ts);
   * absent: every request carries it
   */
  fixedContext?: FixedContextLedger
}

/**
 * Room kept for what wraps the reference excerpts in the system prompt: the
 * sentence before them and the `<translation-references>` tags
 * (packages/ui project-skill.ts, shared/translate-pdf.ts write about 230).
 */
export const REFERENCE_FENCE_CHARS = 400

export interface TranslationInstructions extends ComposedContext {
  /** the prompts (app-wide, project) and the language pair: the start of `text` */
  promptText: string
  /** glossary entries and reference file names: the rest of `text` ('' when none) */
  materialText: string
  /** glossary entries in the text */
  glossaryIncluded: number
  /** entries in the project's glossary */
  glossaryTotal: number
  /**
   * How the entries were chosen: `all` (the glossary is within the limit), `matching` (over
   * the limit, the entries whose term appears in the request text), `first` (over the limit
   * and nothing matched, or no request text: the first entries in file order)
   */
  glossarySelection: 'all' | 'matching' | 'first'
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
 * `composeContext` writes them. `paragraph` is the request text (the
 * person's message and the selection it is about), or '' when unknown.
 *
 * Glossary entries (the spec rule of `selectGlossary`):
 * - a glossary within DEFAULT_GLOSSARY_LIMIT entries goes whole;
 * - over it, the entries whose source term appears in `paragraph`;
 * - over it with no match (or no request text), the first
 *   DEFAULT_GLOSSARY_LIMIT entries in file order, so a short request such as
 *   "translate this" still carries terms.
 * Over `limitChars`, whole entries are dropped from the end until the text
 * fits; if the prompts alone are over it, the text is cut there (`cut`).
 * Reference chunks (`referencesText`) are picked by the same request text
 * and fill what room the text leaves, up to DEFAULT_REFERENCE_CHARS.
 *
 * `options` (a deviation from the plan's two-argument form) carries the
 * settings path, which is per process.
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
  let candidates: GlossaryEntry[]
  let selection: TranslationInstructions['glossarySelection']
  if (glossary.length <= DEFAULT_GLOSSARY_LIMIT) {
    candidates = glossary
    selection = 'all'
  } else {
    const matching =
      paragraph.trim() === '' ? [] : selectGlossary(glossary, paragraph, DEFAULT_GLOSSARY_LIMIT)
    candidates = matching.length > 0 ? matching : glossary.slice(0, DEFAULT_GLOSSARY_LIMIT)
    selection = matching.length > 0 ? 'matching' : 'first'
  }
  const built = fitted(systemPrompt, project, candidates, glossary.length, selection, limit)
  const convert = options.convertReference ?? convertReference
  return withReferences(dir, built, systemPrompt, project, paragraph, limit, convert)
}

/**
 * The reference chunks for `paragraph` (reference-index.ts) in the room the
 * text left under `limit`, at most DEFAULT_REFERENCE_CHARS characters of
 * chunk text: BM25 over the request text, or every chunk when all of them
 * fit. Labelled chunks that still overflow the room are dropped from the end.
 * An unreadable index sends no chunk; it never fails the request.
 */
async function withReferences(
  dir: string,
  built: TranslationInstructions,
  systemPrompt: string,
  project: ProjectFile,
  paragraph: string,
  limit: number,
  convert: ReferenceConverter,
): Promise<TranslationInstructions> {
  const none = { ...built, referencesText: '', referenceChunks: 0 }
  const room = limit - built.text.length - 2 - REFERENCE_FENCE_CHARS
  if (built.cut || room <= 0 || project.references.length === 0) return none
  let chunks: ReferenceChunk[]
  try {
    chunks = await queryReferences(dir, paragraph, Math.min(DEFAULT_REFERENCE_CHARS, room), {
      convert,
    })
  } catch {
    return none
  }
  const label = (list: ReferenceChunk[]) =>
    composeContext({ systemPrompt, project, glossary: [], paragraph: '', references: list })
      .referencesText
  let text = label(chunks)
  while (chunks.length > 0 && text.length > room) {
    chunks = chunks.slice(0, -1)
    text = label(chunks)
  }
  return { ...built, referencesText: text, referenceChunks: chunks.length }
}

function fitted(
  systemPrompt: string,
  project: ProjectFile,
  candidates: GlossaryEntry[],
  total: number,
  selection: TranslationInstructions['glossarySelection'],
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
  // the prompts part alone: no glossary entry and no reference name
  const promptText = composeContext({
    systemPrompt,
    project: { ...project, references: [] },
    glossary: [],
    paragraph: '',
  }).text
  const result = (composed: ComposedContext, count: number, cut: boolean) => {
    const prompts = cut ? composed.text : promptText
    return {
      ...composed,
      promptText: prompts,
      materialText: composed.text.slice(prompts.length).replace(/^\n+/, ''),
      glossaryIncluded: count,
      glossaryTotal: total,
      glossarySelection: selection,
      referenceCount: project.references.length,
      cut,
    }
  }
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
  // the prompts alone are over the limit: send their start, and no material
  const text = cutAt(promptText, limit)
  return result({ ...best, text }, 0, true)
}

/** What the project guide adds to a translation project's context */
export interface TranslationFolderContext {
  /**
   * the fixed part: the prompts, the language pair and the editing rules; or,
   * when `fixedOmitted`, the one-line marker `fixed-context: <hash8>` in its place
   */
  prompts: string
  /** first 8 hex characters of the fixed part's sha-256 */
  fixedHash: string
  /** the fixed part went earlier in this conversation and `prompts` is only its marker */
  fixedOmitted: boolean
  material: string
  /** the reference chunks picked for the request, labelled ('' when none) */
  references: string
  items: ProjectTranslationItem[]
  cut: boolean
}

/**
 * How to translate an open document without losing its structure, appended
 * after the person's prompts in the panel context. The Word editor's
 * replace_blocks rebuilds whole paragraphs from model HTML, which merged runs
 * of different formats, restyled or dropped empty paragraphs and lost
 * footnote references; read_runs / translate_blocks swap text inside the
 * existing runs instead. Other editors do not offer those tools, so the rule
 * names the Word editor.
 */
export const TRANSLATION_EDITING_RULES = [
  'How to translate in the editors of this app:',
  '- In a Word document, translate with read_runs then translate_blocks only: one translated string per segment, in order. Never use replace_blocks, write_document, edit_note or apply_ops to translate; they lose run formatting. translate_blocks tidies spacing itself; do not fix spacing by hand or ask permission.',
  '- When the original must stay (bilingual output), use add_bilingual instead of translate_blocks: same read_runs fp and segments, layout "after" for body paragraphs, "right" or "below" for a whole table in one call; or a per-entry target {kind:"cell",index,row,column} / "after" / "before" / "end" for any place the person names. It adds the translation and shifts later block indexes, so read_runs again before the next call.',
  '- Keep the source formatting, never ignore it: line breaks, tabs, bold, italic, underline, lists, indents and paragraph structure stay exactly where they are. Keep each segment in its own place between the breaks; never merge segments, move text across a break, or add or drop a break. Added italics only sit on top of the source formatting.',
  '- Never delete, fill or restyle empty paragraphs, or move, delete or retype a footnote reference mark.',
  '- Footnotes and endnotes are translated too: read_runs notes:true, then translate_blocks entries with "note" and "id". Tool results state the note counts and what is left; trust them. Translation is not finished until read_runs with checkRemaining:true and sourceLanguage reports nothing left.',
  '- Pass each paragraph\'s "fp" from read_runs to translate_blocks unchanged; a skipped or refused fp (the person edited that paragraph) means call read_runs again for just those blocks; the rest of the call is applied, so continue.',
  '- Review (감수, 검수, proofreading) of a translated document: read_runs then revise_blocks, never translate_blocks; every fix is a tracked change (author "AI Assistant (review)"). Original: project_read of the file in source/ (match paragraphs by content and order), else the bilingual twin (read_runs review:true) or what the person pasted; if none is readable, say so, review only fluency and consistency, never invent an original. Never edit anything in source/.',
  '- Review procedure: compare range by range; revise only real errors (mistranslation, omission, addition, number/name/date, glossary, writing style, kept choices, awkward phrasing), never restyle a correct translation. add_comment only for non-trivial fixes or doubts, never twice; notes cannot carry tracked changes, so mention doubts. Finish with a summary: counts by kind and open doubts.',
].join('\n')

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
 * project file cannot be read. `query` is the request text the AI panel
 * passed along (absent: none), used only to pick glossary entries.
 *
 * `conversation` (with `options.fixedContext`) lets a later request of the
 * same conversation send only the marker of the fixed part, when the provider
 * keeps the earlier system prompt; anything missing sends it whole. The glossary
 * entries and reference chunks go with every request.
 */
export async function translationContextForFolder(
  root: string,
  options: TranslationContextOptions,
  query?: string,
  conversation?: FixedContextConversation,
): Promise<TranslationFolderContext | null> {
  const dir = registeredDir(root, options)
  if (dir === undefined) return null
  if ((await projectStatus(dir)) !== 'ok') return null
  let built: TranslationInstructions
  // the rules ride after the prompts, so the person's material makes room for them
  const limit = Math.max(
    0,
    (options.limitChars ?? INSTRUCTIONS_LIMIT_CHARS) - TRANSLATION_EDITING_RULES.length - 2,
  )
  try {
    built = await buildTranslationInstructions(dir, query ?? '', { ...options, limitChars: limit })
  } catch {
    // a broken glossary or project file sends nothing of the translation tool
    return null
  }
  const included = (kind: ProjectTranslationItem['kind']) =>
    built.items.find((item) => item.kind === kind)?.included ?? false
  const fixed = `${built.promptText}\n\n${TRANSLATION_EDITING_RULES}`
  const hash = fixedContextHash(fixed)
  // Dormant (decision 0103): no panel passes a conversation today. Before turning it on:
  // (I1) record the hash only after the send is confirmed delivered, forget() on failure;
  // (I2) key the ledger by provider and model too, decide providerKeepsSystem in main
  // instead of trusting the renderer, and reset the conversation on history trim/summary.
  const send =
    !options.fixedContext ||
    !conversation ||
    options.fixedContext.shouldSend(
      conversation.id,
      canonicalPath(dir),
      hash,
      conversation.providerKeepsSystem === true,
    )
  return {
    prompts: send ? fixed : fixedContextMarker(hash),
    fixedHash: hash.slice(0, 8),
    fixedOmitted: !send,
    material: built.materialText,
    references: built.referencesText,
    cut: built.cut,
    items: [
      { kind: 'system', included: included('system') },
      { kind: 'project', included: included('project') },
      {
        kind: 'glossary',
        included: built.glossaryIncluded > 0,
        count: built.glossaryIncluded,
        total: built.glossaryTotal,
        ...(built.glossarySelection === 'matching' ? { selection: 'matching' as const } : {}),
      },
      {
        kind: 'reference',
        included: included('reference'),
        count: built.referenceCount,
      },
    ],
  }
}
