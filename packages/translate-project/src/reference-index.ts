import { createHash, randomBytes } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { withProjectLock } from './project-lock'
import { loadProject } from './project-store'
import type { ReferenceConversion } from './reference-md'

/**
 * The keyword index over a project's reference files (decision 0102).
 *
 * - Each reference is converted to markdown (reference-md.ts, reading
 *   injected by the shell) into `references/.md/<name>.md`; the file in
 *   `references/` itself is only read.
 * - `.tandem/references-index.json` holds, per file, the SHA-256 of the
 *   reference, its status, the SHA-256 of the converted copy and its chunks
 *   (heading, offset, length and term frequencies). Chunk text is read back
 *   from the converted copy by offset.
 * - A request picks chunks by BM25 over its own text (`queryReferences`).
 *   When everything together fits in the cap, everything goes, unranked.
 *
 * Keyword search only: no embeddings and no local model. Failures are
 * recorded per file; nothing here throws for one bad reference.
 *
 * Links are never followed out of the project (a folder adopted from
 * elsewhere may carry them): a reference, `references/`, `references/.md/`,
 * a converted copy or `.tandem/` that is a symbolic link or resolves outside
 * the project folder is not read, written or deleted. Such a reference is
 * recorded as `outside`.
 */

export type ReferenceConverter = (path: string) => Promise<ReferenceConversion>

/**
 * `outside`: the reference (or the folder its converted copy goes to) is a
 * link or lies outside the project folder, so it is never read
 */
export type ReferenceStatus = 'converted' | 'needs-ocr' | 'unsupported' | 'failed' | 'outside'

export interface ReferenceChunk {
  file: string
  heading: string
  text: string
}

/** chunks sent with one request: at most this many characters of reference text */
export const DEFAULT_REFERENCE_CHARS = 6000

/** a chunk is a heading's paragraphs up to this many characters */
export const REFERENCE_CHUNK_CHARS = 1200

export const REFERENCE_MD_DIR = '.md'
export const REFERENCE_INDEX_FILE = 'references-index.json'

/** a request's text is ranked by its first this many characters (unique terms) */
export const REFERENCE_QUERY_CHARS = 4000

const STATE_DIR = '.tandem'
const INDEX_VERSION = 1
const BM25_K1 = 1.2
const BM25_B = 0.75

interface IndexedChunk {
  heading: string
  offset: number
  length: number
  terms: Record<string, number>
}

interface IndexedFile {
  file: string
  /** of the file in references/; '' when it could not be read */
  sha256: string
  status: ReferenceStatus
  /** of the converted copy; present when converted */
  mdSha256?: string
  /** size and change time of the reference when indexed (absent: it could not be read) */
  size?: number
  mtimeMs?: number
  chunks: IndexedChunk[]
}

interface ReferenceIndex {
  version: number
  files: IndexedFile[]
}

// ---- tokens ----

const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/**
 * Search terms of `text`: NFKC, lower case, runs of letters, marks and
 * digits. Korean, Chinese and Japanese runs (which carry no spaces between
 * words, or glue particles to them) become character bigrams; a lone
 * character stays a term of its own. Other scripts give whole words.
 */
export function tokenize(text: string): string[] {
  const out: string[] = []
  const flush = (run: string[], cjk: boolean) => {
    if (run.length === 0) return
    if (!cjk) out.push(run.join(''))
    else if (run.length === 1) out.push(run[0]!)
    else for (let i = 0; i + 1 < run.length; i += 1) out.push(run[i]! + run[i + 1]!)
  }
  for (const match of text
    .normalize('NFKC')
    .toLowerCase()
    .matchAll(/[\p{L}\p{M}\p{N}]+/gu)) {
    let run: string[] = []
    let cjk = false
    for (const ch of match[0]) {
      const isCjk = CJK_CHAR.test(ch)
      if (run.length > 0 && isCjk !== cjk) {
        flush(run, cjk)
        run = []
      }
      cjk = isCjk
      run.push(ch)
    }
    flush(run, cjk)
  }
  return out
}

function termCounts(text: string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const term of tokenize(text)) counts[term] = (counts[term] ?? 0) + 1
  return counts
}

// ---- chunks ----

/** `end` moved back so a cut never splits a surrogate pair */
function safeEnd(text: string, end: number): number {
  const code = text.charCodeAt(end - 1)
  return code >= 0xd800 && code <= 0xdbff ? end - 1 : end
}

/**
 * Chunks of markdown, as ranges of it: a heading starts a chunk and labels
 * the chunks after it; paragraphs (blocks between blank lines) are grouped
 * up to REFERENCE_CHUNK_CHARS; a longer paragraph is cut at a line break,
 * else at the limit.
 */
export function chunkMarkdown(md: string): { heading: string; offset: number; length: number }[] {
  const blocks: { start: number; end: number; heading?: string }[] = []
  const blockRe = /[^\n]*\S[^\n]*(?:\n[^\n]*\S[^\n]*)*/g
  for (const match of md.matchAll(blockRe)) {
    const raw = match[0]
    const lead = raw.length - raw.trimStart().length
    const start = match.index + lead
    const end = match.index + raw.trimEnd().length
    const lineBreak = md.indexOf('\n', start)
    const firstLine = md.slice(start, lineBreak < 0 || lineBreak > end ? end : lineBreak)
    const heading = /^#{1,6}\s+(.*)$/.exec(firstLine)
    // a long block is cut into pieces no longer than a chunk
    let from = start
    let first = true
    while (from < end) {
      let to = end
      if (to - from > REFERENCE_CHUNK_CHARS) {
        const limit = from + REFERENCE_CHUNK_CHARS
        const lineBreak = md.lastIndexOf('\n', limit - 1)
        to = lineBreak > from ? lineBreak : safeEnd(md, limit)
      }
      const piece = { start: from, end: to }
      blocks.push(first && heading ? { ...piece, heading: heading[1]!.trim() } : piece)
      first = false
      from = to
      while (from < end && /\s/.test(md[from]!)) from += 1
    }
  }

  const chunks: { heading: string; offset: number; length: number }[] = []
  let heading = ''
  let open: { start: number; end: number } | null = null
  const close = () => {
    if (open) chunks.push({ heading, offset: open.start, length: open.end - open.start })
    open = null
  }
  for (const block of blocks) {
    if (block.heading !== undefined) {
      close()
      heading = block.heading
    } else if (open && block.end - open.start > REFERENCE_CHUNK_CHARS) {
      close()
    }
    open = open ? { start: open.start, end: block.end } : { start: block.start, end: block.end }
  }
  close()
  return chunks
}

// ---- the file system, links never followed ----

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function isPlainName(file: unknown): file is string {
  return (
    typeof file === 'string' &&
    file !== '' &&
    file !== '.' &&
    file !== '..' &&
    !/[\\/]/.test(file) &&
    !file.includes('\0')
  )
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path)
  } catch {
    return null
  }
}

/** whether `path` resolves to the project folder `dir` itself or somewhere inside it */
async function resolvesInside(dir: string, path: string): Promise<boolean> {
  try {
    const [root, real] = await Promise.all([realpath(dir), realpath(path)])
    return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep)
  } catch {
    return false
  }
}

type DirCheck = 'ok' | 'missing' | 'outside' | 'blocked'

/** a real directory (not a link) inside the project: `ok`; `blocked`: a file holds the name */
async function checkDir(dir: string, path: string): Promise<DirCheck> {
  const st = await lstatOrNull(path)
  if (!st) return 'missing'
  if (st.isSymbolicLink()) return 'outside'
  if (!st.isDirectory()) return 'blocked'
  return (await resolvesInside(dir, path)) ? 'ok' : 'outside'
}

function referencesDir(dir: string): string {
  return join(dir, 'references')
}

function mdDirPath(dir: string): string {
  return join(dir, 'references', REFERENCE_MD_DIR)
}

/** `references/.md/`, made when `create` and missing; its check otherwise */
async function mdDir(dir: string, create: boolean): Promise<DirCheck> {
  const parent = await checkDir(dir, referencesDir(dir))
  if (parent !== 'ok') return parent === 'missing' ? 'missing' : 'outside'
  let check = await checkDir(dir, mdDirPath(dir))
  if (check === 'missing' && create) {
    await mkdir(mdDirPath(dir)).catch(() => undefined)
    check = await checkDir(dir, mdDirPath(dir))
  }
  return check
}

type SourceCheck = { kind: 'ok'; path: string; st: Stats } | { kind: 'missing' | 'outside' }

/** `references/<file>`: a regular file (not a link) inside the project, or why not */
async function checkSource(dir: string, file: string): Promise<SourceCheck> {
  const parent = await checkDir(dir, referencesDir(dir))
  if (parent === 'missing') return { kind: 'missing' }
  if (parent !== 'ok') return { kind: 'outside' }
  const path = join(referencesDir(dir), file)
  const st = await lstatOrNull(path)
  if (!st) return { kind: 'missing' }
  if (st.isSymbolicLink()) return { kind: 'outside' }
  if (!st.isFile()) return { kind: 'missing' }
  if (!(await resolvesInside(dir, path))) return { kind: 'outside' }
  return { kind: 'ok', path, st }
}

/** the converted copy of `file` when it is a regular file directly in a safe `references/.md/` */
async function safeMdFile(dir: string, file: string): Promise<{ path: string; st: Stats } | null> {
  if ((await mdDir(dir, false)) !== 'ok') return null
  const path = join(mdDirPath(dir), `${file}.md`)
  const st = await lstatOrNull(path)
  if (!st || !st.isFile()) return null
  return (await resolvesInside(mdDirPath(dir), path)) ? { path, st } : null
}

/** Remove a converted copy, only when it is a regular file directly in `references/.md/`. */
async function removeMdFile(dir: string, file: string): Promise<void> {
  const found = await safeMdFile(dir, file)
  if (found) await rm(found.path, { force: true }).catch(() => undefined)
}

/** `.tandem/` when it is a real directory inside the project, else null */
async function stateDir(dir: string): Promise<string | null> {
  const path = join(dir, STATE_DIR)
  return (await checkDir(dir, path)) === 'ok' ? path : null
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(tmp, text, { encoding: 'utf8', flag: 'wx' })
    await rename(tmp, path)
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw e
  }
}

// ---- the index file, cached by size and change time ----

const STATUSES: readonly ReferenceStatus[] = [
  'converted',
  'needs-ocr',
  'unsupported',
  'failed',
  'outside',
]

const indexCache = new Map<string, { size: number; mtimeMs: number; index: ReferenceIndex }>()
const mdCache = new Map<string, { size: number; mtimeMs: number; sha: string; text: string }>()

const emptyIndex = (): ReferenceIndex => ({ version: INDEX_VERSION, files: [] })

function parseIndex(text: string): ReferenceIndex {
  try {
    const parsed = JSON.parse(text) as ReferenceIndex
    if (parsed?.version !== INDEX_VERSION || !Array.isArray(parsed.files)) return emptyIndex()
    const files = parsed.files.filter(
      (f) =>
        isPlainName(f?.file) &&
        typeof f.sha256 === 'string' &&
        STATUSES.includes(f.status) &&
        Array.isArray(f.chunks),
    )
    return { version: INDEX_VERSION, files }
  } catch {
    return emptyIndex()
  }
}

/**
 * The index, or an empty one when it is missing, damaged, a link or under a
 * `.tandem/` that is not a real folder of the project (it is rebuilt from the
 * files). Parsed once per size and change time of the file.
 */
async function loadIndex(dir: string): Promise<ReferenceIndex> {
  const state = await stateDir(dir)
  if (!state) return emptyIndex()
  const path = join(state, REFERENCE_INDEX_FILE)
  const st = await lstatOrNull(path)
  if (!st || !st.isFile()) return emptyIndex()
  const cached = indexCache.get(path)
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.index
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return emptyIndex()
  }
  const index = parseIndex(text)
  indexCache.set(path, { size: st.size, mtimeMs: st.mtimeMs, index })
  return index
}

/** The converted copy's text when it still matches `mdSha256`, read once per size and change time. */
async function convertedText(dir: string, entry: IndexedFile): Promise<string | null> {
  const found = await safeMdFile(dir, entry.file)
  if (!found) return null
  const cached = mdCache.get(found.path)
  if (!cached || cached.size !== found.st.size || cached.mtimeMs !== found.st.mtimeMs) {
    let bytes: Buffer
    try {
      bytes = await readFile(found.path)
    } catch {
      return null
    }
    mdCache.set(found.path, {
      size: found.st.size,
      mtimeMs: found.st.mtimeMs,
      sha: sha256(bytes),
      text: bytes.toString('utf8'),
    })
  }
  const live = mdCache.get(found.path)!
  return live.sha === entry.mdSha256 ? live.text : null
}

// ---- building the index ----

async function convertOne(
  dir: string,
  file: string,
  base: Pick<IndexedFile, 'sha256' | 'size' | 'mtimeMs'>,
  path: string,
  convert: ReferenceConverter,
): Promise<IndexedFile> {
  const entry = (status: ReferenceStatus): IndexedFile => ({ file, ...base, status, chunks: [] })
  let result: ReferenceConversion
  try {
    result = await convert(path)
  } catch {
    result = { ok: false, reason: 'failed' }
  }
  if (!result.ok) {
    await removeMdFile(dir, file)
    return entry(result.reason)
  }
  const md = result.md
  const target = await mdDir(dir, true)
  if (target !== 'ok') return entry(target === 'outside' ? 'outside' : 'failed')
  const mdFile = join(mdDirPath(dir), `${file}.md`)
  const existing = await lstatOrNull(mdFile)
  // a link or a folder in place of the copy is never written through
  if (existing && !existing.isFile()) return entry('outside')
  try {
    await writeAtomic(mdFile, md)
  } catch {
    return entry('failed')
  }
  const chunks = chunkMarkdown(md).map((c) => ({
    ...c,
    terms: termCounts(md.slice(c.offset, c.offset + c.length)),
  }))
  return { file, ...base, status: 'converted', mdSha256: sha256(md), chunks }
}

/**
 * Bring the index in line with `files` (the project's reference list):
 * convert a file that is new or whose SHA-256 changed (or whose converted
 * copy is gone or was edited), keep the rest, drop entries and converted
 * copies of files no longer listed. A file that failed before is tried
 * again. A reference named like the converted-copy folder fails alone. The
 * caller holds the project lock. Never throws: an index that cannot be
 * written leaves the statuses as answered and the old index.
 */
export async function syncReferenceIndex(
  dir: string,
  files: readonly string[],
  convert: ReferenceConverter,
): Promise<Record<string, ReferenceStatus>> {
  const index = await loadIndex(dir)
  const previous = new Map(index.files.map((f) => [f.file, f]))
  const next: IndexedFile[] = []
  for (const file of files) {
    if (!isPlainName(file)) continue
    if (file === REFERENCE_MD_DIR) {
      next.push({ file, sha256: '', status: 'failed', chunks: [] })
      continue
    }
    const source = await checkSource(dir, file)
    if (source.kind !== 'ok') {
      const status = source.kind === 'outside' ? 'outside' : 'failed'
      next.push({ file, sha256: '', status, chunks: [] })
      continue
    }
    let bytes: Buffer
    try {
      bytes = await readFile(source.path)
    } catch {
      next.push({ file, sha256: '', status: 'failed', chunks: [] })
      continue
    }
    const base = { sha256: sha256(bytes), size: source.st.size, mtimeMs: source.st.mtimeMs }
    const old = previous.get(file)
    if (old && old.sha256 === base.sha256 && old.status !== 'failed' && old.status !== 'outside') {
      // the same content: keep the entry, with the size and time seen now
      if (old.status !== 'converted' || (await convertedText(dir, old)) !== null) {
        next.push({ ...old, ...base })
        continue
      }
    }
    next.push(await convertOne(dir, file, base, source.path, convert))
  }
  const listed = new Set(next.map((f) => f.file))
  for (const old of index.files) {
    if (!listed.has(old.file) && old.file !== REFERENCE_MD_DIR) await removeMdFile(dir, old.file)
  }
  const state = await stateDir(dir)
  if (state) {
    try {
      await writeAtomic(
        join(state, REFERENCE_INDEX_FILE),
        `${JSON.stringify({ version: INDEX_VERSION, files: next })}\n`,
      )
    } catch {
      // the statuses below still hold for this call; the next sync tries again
    }
  }
  return Object.fromEntries(next.map((f) => [f.file, f.status]))
}

/** Each indexed reference's status, as last recorded (a file not indexed yet is absent). */
export async function referenceStatuses(dir: string): Promise<Record<string, ReferenceStatus>> {
  const index = await loadIndex(dir)
  return Object.fromEntries(index.files.map((f) => [f.file, f.status]))
}

/** The converted markdown of a listed, converted reference, or null (links are never read). */
export async function readConvertedReference(dir: string, file: string): Promise<string | null> {
  if (!isPlainName(file)) return null
  const index = await loadIndex(dir)
  const entry = index.files.find((f) => f.file === file)
  if (!entry || entry.status !== 'converted') return null
  if ((await checkSource(dir, file)).kind !== 'ok') return null
  return convertedText(dir, entry)
}

/**
 * Whether the index lags the project's reference list: a listed reference
 * it does not know, or one whose size or change time differs from when it
 * was indexed. Only `lstat`, no reading.
 */
async function indexLags(dir: string, files: readonly string[]): Promise<boolean> {
  const index = await loadIndex(dir)
  if (index.files.length !== files.length) return true
  const known = new Map(index.files.map((f) => [f.file, f]))
  for (const file of files) {
    if (!isPlainName(file)) continue
    const entry = known.get(file)
    if (!entry) return true
    const source = await checkSource(dir, file)
    const size = source.kind === 'ok' ? source.st.size : undefined
    const mtimeMs = source.kind === 'ok' ? source.st.mtimeMs : undefined
    if (size !== entry.size || mtimeMs !== entry.mtimeMs) return true
  }
  return false
}

export interface QueryReferencesOptions {
  /** Person-selected examples to consult even for a request without topical keywords. */
  wikiExamples?: readonly string[]
  /**
   * converts a reference again when the index lags the folder (a reference
   * edited in place, or a project from before the index); absent: the index
   * is used as it is
   */
  convert?: ReferenceConverter
}

interface LiveChunk extends ReferenceChunk {
  terms: Record<string, number>
  size: number
}

/**
 * The reference chunks for one request whose text is `text`, at most
 * `maxChars` characters of chunk text in all:
 * - all chunks together at or below `maxChars`: every chunk, in file order,
 *   unranked (a small corpus always goes whole);
 * - otherwise BM25 (k1 1.2, b 0.75) over the unique terms of the first
 *   REFERENCE_QUERY_CHARS characters of the request, best first, each chunk
 *   that still fits. Explicitly selected wiki notes may also contribute a
 *   small sample across files when the request lacks matching terms.
 * With `options.convert`, a lagging index is brought up to date first (under
 * the project lock). A converted copy that no longer matches the index is
 * skipped until the next sync rebuilds it.
 */
export async function queryReferences(
  dir: string,
  text: string,
  maxChars: number,
  options: QueryReferencesOptions = {},
): Promise<ReferenceChunk[]> {
  const convert = options.convert
  let listed: Set<string> | undefined
  if (convert) {
    try {
      const project = await loadProject(dir)
      listed = new Set(project.references)
      if (await indexLags(dir, project.references)) {
        await withProjectLock(dir, async () => {
          const current = await loadProject(dir)
          await syncReferenceIndex(dir, current.references, convert)
        })
      }
    } catch {
      // the index as it is answers this request
    }
  }
  const index = await loadIndex(dir)
  const chunks: LiveChunk[] = []
  const wikiExamples = new Set(options.wikiExamples)
  for (const entry of index.files) {
    if (entry.status !== 'converted' || (listed && !listed.has(entry.file))) continue
    const md = await convertedText(dir, entry)
    if (md === null) continue
    const generatedExample =
      wikiExamples.has(entry.file) && md.startsWith('---\nkind: final-style-example\n')
    for (const c of entry.chunks) {
      const text = md.slice(c.offset, c.offset + c.length)
      // Generated notes put the source excerpts under level-three headings. The
      // front matter and catalog links only help navigation inside Obsidian.
      if (generatedExample && !text.startsWith('### ')) continue
      const terms = c.terms && typeof c.terms === 'object' ? c.terms : {}
      let size = 0
      for (const v of Object.values(terms)) size += v
      chunks.push({
        file: entry.file,
        heading: c.heading,
        text,
        terms,
        size,
      })
    }
  }
  const plain = (c: LiveChunk): ReferenceChunk => ({
    file: c.file,
    heading: c.heading,
    text: c.text,
  })
  let total = 0
  for (const c of chunks) total += c.text.length
  if (total <= maxChars) return chunks.map(plain)

  const query = new Set(tokenize(text.slice(0, REFERENCE_QUERY_CHARS)))
  if (chunks.length === 0 || (!query.size && !wikiExamples.size)) return []
  let sizes = 0
  for (const c of chunks) sizes += c.size
  const avg = sizes / chunks.length || 1
  // document frequencies in one pass, walking the smaller side of each chunk
  const df = new Map<string, number>()
  const matched: string[][] = []
  for (const c of chunks) {
    const hits: string[] = []
    const keys = Object.keys(c.terms)
    if (keys.length < query.size) {
      for (const term of keys) if (query.has(term)) hits.push(term)
    } else {
      for (const term of query) if ((c.terms[term] ?? 0) > 0) hits.push(term)
    }
    for (const term of hits) df.set(term, (df.get(term) ?? 0) + 1)
    matched.push(hits)
  }
  const n = chunks.length
  const scored = chunks
    .map((c, order) => {
      let score = 0
      for (const term of matched[order]!) {
        const tf = c.terms[term]!
        const d = df.get(term) ?? 0
        const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5))
        const norm = tf + BM25_K1 * (1 - BM25_B + (BM25_B * c.size) / avg)
        score += idf * ((tf * (BM25_K1 + 1)) / norm)
      }
      return { c, score, order }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
  const picked: ReferenceChunk[] = []
  let used = 0
  // A broad instruction such as “translate this” has no document keywords.
  // Reserve up to one chunk's worth of room across the chosen wiki notes,
  // taking their best matching excerpts first and then their earliest samples.
  const included = new Set<LiveChunk>()
  if (wikiExamples.size) {
    const samples = new Map<string, LiveChunk>()
    for (const { c } of scored)
      if (wikiExamples.has(c.file) && !samples.has(c.file)) samples.set(c.file, c)
    for (const c of chunks)
      if (wikiExamples.has(c.file) && !samples.has(c.file)) samples.set(c.file, c)
    const sampleBudget = Math.min(REFERENCE_CHUNK_CHARS, maxChars)
    for (const c of samples.values()) {
      if (used + c.text.length > sampleBudget) continue
      picked.push(plain(c))
      included.add(c)
      used += c.text.length
    }
  }
  for (const { c } of scored) {
    if (included.has(c) || used + c.text.length > maxChars) continue
    picked.push(plain(c))
    used += c.text.length
  }
  return picked
}
