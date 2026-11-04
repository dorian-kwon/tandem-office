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
): ProjectFile {
  return {
    version: 1,
    name,
    sourceLang,
    targetLang,
    projectPrompt: '',
    ocr: { kind: 'ai', provider: 'claude' },
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
  return {
    version: 1,
    name: str(raw, 'name'),
    sourceLang: str(raw, 'sourceLang'),
    targetLang: str(raw, 'targetLang'),
    projectPrompt: str(raw, 'projectPrompt'),
    ocr: parseOcr(raw.ocr),
    writingStyle: parseWritingStyle(raw.writingStyle),
    sources: raw.sources.map(parseSource),
    references: strList(raw, 'references'),
    glossaryFiles: strList(raw, 'glossaryFiles'),
  }
}

export function serializeProjectFile(p: ProjectFile): string {
  return `${JSON.stringify(p, null, 2)}\n`
}
