export type OcrMode = { kind: 'off' } | { kind: 'ai'; provider: 'claude' | 'chatgpt' }

export type SourceKind = 'editable' | 'pdf' | 'scan' | 'image'

export type SourceEntry = { file: string; sha256: string; kind: SourceKind }

export type ProjectFile = {
  version: 1
  name: string
  sourceLang: string
  targetLang: string
  projectPrompt: string
  ocr: OcrMode
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

function strList(o: Record<string, unknown>, key: string): string[] {
  const v = o[key]
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new ProjectFileError(`${key} must be an array of strings`)
  }
  return [...(v as string[])]
}

function parseOcr(v: unknown): OcrMode {
  if (!isRecord(v)) throw new ProjectFileError('ocr must be an object')
  if (v.kind === 'off') return { kind: 'off' }
  if (v.kind === 'ai' && (v.provider === 'claude' || v.provider === 'chatgpt')) {
    return { kind: 'ai', provider: v.provider }
  }
  throw new ProjectFileError('ocr has an unknown kind or provider')
}

function parseSource(v: unknown): SourceEntry {
  if (!isRecord(v)) throw new ProjectFileError('source entry must be an object')
  const kind = str(v, 'kind', 'source ')
  if (!SOURCE_KINDS.includes(kind)) throw new ProjectFileError(`unknown source kind: ${kind}`)
  return {
    file: str(v, 'file', 'source '),
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
    sources: raw.sources.map(parseSource),
    references: strList(raw, 'references'),
    glossaryFiles: strList(raw, 'glossaryFiles'),
  }
}

export function serializeProjectFile(p: ProjectFile): string {
  return `${JSON.stringify(p, null, 2)}\n`
}
