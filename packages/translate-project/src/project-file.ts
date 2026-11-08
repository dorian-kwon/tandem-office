export type OcrMode = { kind: 'off' } | { kind: 'ai'; provider: 'claude' | 'chatgpt' }

/** Serial (Oxford) comma choice; `default` follows the target language's usual convention. */
export type SerialComma = 'default' | 'with' | 'without'

/** Where a comma or period goes relative to a closing quotation mark. */
export type QuotePunctuation = 'default' | 'outside' | 'inside'

export type WritingStyle = {
  serialComma: SerialComma
  quotePunctuation: QuotePunctuation
  /** free-text instruction from the person; '' when none */
  custom: string
}

/**
 * Answers the person gave to the AI's numbered questions and asked to keep for the whole
 * project. The value is the chosen option's text or what they typed; absent means "not decided
 * yet", and the AI must ask (ask_choice) before writing.
 * - outputMode: overwrite the output copy, or keep the original and add the translation beside it
 * - bilingual: the layout of the added translation (only when the original is kept)
 * - ocrPlacement: where text read from pictures goes
 */
export const TRANSLATION_CHOICE_KEYS = ['outputMode', 'bilingual', 'ocrPlacement'] as const
export type TranslationChoiceKey = (typeof TRANSLATION_CHOICE_KEYS)[number]
export type TranslationChoices = Partial<Record<TranslationChoiceKey, string>>
/** Longest stored answer; a longer one is cut when read */
export const TRANSLATION_CHOICE_MAX_CHARS = 300

export type SourceKind = 'editable' | 'pdf' | 'scan' | 'image'

export type SourceEntry = { file: string; sha256: string; kind: SourceKind }

export type ProjectFile = {
  version: 1
  name: string
  sourceLang: string
  targetLang: string
  projectPrompt: string
  ocr: OcrMode
  /** absent in files written before this field existed; read as the default style */
  writingStyle: WritingStyle
  /** absent until the person keeps an answer; absent and empty mean the same */
  choices?: TranslationChoices
  sources: SourceEntry[]
  references: string[]
  glossaryFiles: string[]
}

export class ProjectFileError extends Error {
  constructor(message: string) {
    super(`project file: ${message}`)
    this.name = 'ProjectFileError'
  }
}

const SOURCE_KINDS: readonly string[] = ['editable', 'pdf', 'scan', 'image']

export function defaultWritingStyle(): WritingStyle {
  return { serialComma: 'default', quotePunctuation: 'default', custom: '' }
}

export function defaultProjectFile(
  name: string,
  sourceLang: string,
  targetLang: string,
  ocr: OcrMode = { kind: 'ai', provider: 'claude' },
): ProjectFile {
  return {
    version: 1,
    name,
    sourceLang,
    targetLang,
    projectPrompt: '',
    ocr,
    writingStyle: defaultWritingStyle(),
    sources: [],
    references: [],
    glossaryFiles: [],
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(o: Record<string, unknown>, key: string, where = ''): string {
  const v = o[key]
  if (typeof v !== 'string') throw new ProjectFileError(`${where}${key} must be a string`)
  return v
}

/** A plain file name: not empty, no path separator, not `.` or `..`. */
function plainFileName(name: string, where: string): string {
  if (name === '' || name === '.' || name === '..' || /[\\/]/.test(name)) {
    throw new ProjectFileError(`${where} must be a plain file name`)
  }
  return name
}

function strList(o: Record<string, unknown>, key: string): string[] {
  const v = o[key]
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new ProjectFileError(`${key} must be an array of strings`)
  }
  return (v as string[]).map((x) => plainFileName(x, `${key} entry`))
}

function parseOcr(v: unknown): OcrMode {
  if (!isRecord(v)) throw new ProjectFileError('ocr must be an object')
  if (v.kind === 'off') return { kind: 'off' }
  if (v.kind === 'ai' && (v.provider === 'claude' || v.provider === 'chatgpt')) {
    return { kind: 'ai', provider: v.provider }
  }
  throw new ProjectFileError('ocr has an unknown kind or provider')
}

function parseWritingStyle(v: unknown): WritingStyle {
  if (v === undefined) return defaultWritingStyle()
  if (!isRecord(v)) throw new ProjectFileError('writingStyle must be an object')
  const out = defaultWritingStyle()
  if (v.serialComma !== undefined) {
    if (v.serialComma !== 'default' && v.serialComma !== 'with' && v.serialComma !== 'without')
      throw new ProjectFileError('writingStyle.serialComma is unknown')
    out.serialComma = v.serialComma
  }
  if (v.quotePunctuation !== undefined) {
    if (
      v.quotePunctuation !== 'default' &&
      v.quotePunctuation !== 'outside' &&
      v.quotePunctuation !== 'inside'
    )
      throw new ProjectFileError('writingStyle.quotePunctuation is unknown')
    out.quotePunctuation = v.quotePunctuation
  }
  if (v.custom !== undefined) {
    if (typeof v.custom !== 'string')
      throw new ProjectFileError('writingStyle.custom must be a string')
    out.custom = v.custom
  }
  return out
}

function parseChoices(v: unknown): TranslationChoices | undefined {
  // a malformed value must not make the whole project unreadable: it reads as none
  if (!isRecord(v)) return undefined
  const out: TranslationChoices = {}
  for (const key of TRANSLATION_CHOICE_KEYS) {
    const value = v[key]
    if (typeof value !== 'string') continue
    const text = value.replace(/\s+/g, ' ').trim().slice(0, TRANSLATION_CHOICE_MAX_CHARS)
    if (text !== '') out[key] = text
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** A copy of `p` with one answer set, or cleared with `null` (an empty set is dropped) */
export function withChoice(
  p: ProjectFile,
  key: TranslationChoiceKey,
  value: string | null,
): ProjectFile {
  const next: TranslationChoices = { ...p.choices }
  if (value === null || value.trim() === '') delete next[key]
  else next[key] = value
  const { choices: _old, ...rest } = p
  return Object.keys(next).length > 0 ? { ...rest, choices: next } : rest
}

function parseSource(v: unknown): SourceEntry {
  if (!isRecord(v)) throw new ProjectFileError('source entry must be an object')
  const kind = str(v, 'kind', 'source ')
  if (!SOURCE_KINDS.includes(kind)) throw new ProjectFileError(`unknown source kind: ${kind}`)
  return {
    file: plainFileName(str(v, 'file', 'source '), 'source file'),
    sha256: str(v, 'sha256', 'source '),
    kind: kind as SourceKind,
  }
}

/** Parse and validate a project file. Unknown keys are dropped. */
export function parseProjectFile(json: string): ProjectFile {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    throw new ProjectFileError('not valid JSON')
  }
  if (!isRecord(raw)) throw new ProjectFileError('root must be an object')
  if (raw.version !== 1) throw new ProjectFileError(`unsupported version: ${String(raw.version)}`)
  if (!Array.isArray(raw.sources)) throw new ProjectFileError('sources must be an array')
  const choices = parseChoices(raw.choices)
  return {
    version: 1,
    name: str(raw, 'name'),
    sourceLang: str(raw, 'sourceLang'),
    targetLang: str(raw, 'targetLang'),
    projectPrompt: str(raw, 'projectPrompt'),
    ocr: parseOcr(raw.ocr),
    writingStyle: parseWritingStyle(raw.writingStyle),
    ...(choices ? { choices } : {}),
    sources: raw.sources.map(parseSource),
    references: strList(raw, 'references'),
    glossaryFiles: strList(raw, 'glossaryFiles'),
  }
}

export function serializeProjectFile(p: ProjectFile): string {
  return `${JSON.stringify(p, null, 2)}\n`
}
