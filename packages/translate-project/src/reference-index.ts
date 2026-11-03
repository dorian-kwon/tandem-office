import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
 */

export type ReferenceConverter = (path: string) => Promise<ReferenceConversion>

export type ReferenceStatus = 'converted' | 'needs-ocr' | 'unsupported' | 'failed'

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

// ---- the index file ----

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function indexPath(dir: string): string {
  return join(dir, STATE_DIR, REFERENCE_INDEX_FILE)
}

function mdPath(dir: string, file: string): string {
  return join(dir, 'references', REFERENCE_MD_DIR, `${file}.md`)
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

const STATUSES: readonly ReferenceStatus[] = ['converted', 'needs-ocr', 'unsupported', 'failed']

/** The index, or an empty one when it is missing or damaged (it is rebuilt from the files). */
async function loadIndex(dir: string): Promise<ReferenceIndex> {
  try {
    const parsed = JSON.parse(await readFile(indexPath(dir), 'utf8')) as ReferenceIndex
    if (parsed?.version !== INDEX_VERSION || !Array.isArray(parsed.files)) throw new Error('index')
    const files = parsed.files.filter(
      (f) =>
        isPlainName(f?.file) &&
        typeof f.sha256 === 'string' &&
        STATUSES.includes(f.status) &&
        Array.isArray(f.chunks),
    )
    return { version: INDEX_VERSION, files }
  } catch {
    return { version: INDEX_VERSION, files: [] }
  }
}

async function writeAtomic(path: string, dirOf: string, text: string): Promise<void> {
  await mkdir(dirOf, { recursive: true })
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, path)
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw e
  }
}

async function readOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch {
    return null
  }
}

async function convertOne(
  dir: string,
  file: string,
  sha: string,
  convert: ReferenceConverter,
): Promise<IndexedFile> {
  let result: ReferenceConversion
  try {
    result = await convert(join(dir, 'references', file))
  } catch {
    result = { ok: false, reason: 'failed' }
  }
  if (!result.ok) {
    await rm(mdPath(dir, file), { force: true }).catch(() => undefined)
    return { file, sha256: sha, status: result.reason, chunks: [] }
  }
  const md = result.md
  try {
    await writeAtomic(mdPath(dir, file), join(dir, 'references', REFERENCE_MD_DIR), md)
  } catch {
    return { file, sha256: sha, status: 'failed', chunks: [] }
  }
  const chunks = chunkMarkdown(md).map((c) => ({
    ...c,
    terms: termCounts(md.slice(c.offset, c.offset + c.length)),
  }))
  return { file, sha256: sha, status: 'converted', mdSha256: sha256(md), chunks }
}

/**
 * Bring the index in line with `files` (the project's reference list):
 * convert a file that is new or whose SHA-256 changed (or whose converted
 * copy is gone or was edited), keep the rest, drop entries and converted
 * copies of files no longer listed. A file that failed before is tried
 * again. The caller holds the project lock. Never throws: an index that
 * cannot be written leaves the statuses as answered and the old index.
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
    const bytes = await readOrNull(join(dir, 'references', file))
    if (bytes === null) {
      next.push({ file, sha256: '', status: 'failed', chunks: [] })
      continue
    }
    const sha = sha256(bytes)
    const old = previous.get(file)
    if (old && old.sha256 === sha && old.status !== 'failed') {
      if (old.status !== 'converted') {
        next.push(old)
        continue
      }
      const md = await readOrNull(mdPath(dir, file))
      if (md !== null && sha256(md) === old.mdSha256) {
        next.push(old)
        continue
      }
    }
    next.push(await convertOne(dir, file, sha, convert))
  }
  const listed = new Set(next.map((f) => f.file))
  for (const old of index.files) {
    if (!listed.has(old.file))
      await rm(mdPath(dir, old.file), { force: true }).catch(() => undefined)
  }
  try {
    await writeAtomic(
      indexPath(dir),
      join(dir, STATE_DIR),
      `${JSON.stringify({ version: INDEX_VERSION, files: next })}\n`,
    )
  } catch {
    // the statuses below still hold for this call; the next sync tries again
  }
  return Object.fromEntries(next.map((f) => [f.file, f.status]))
}

/** Each indexed reference's status, as last recorded (a file not indexed yet is absent). */
export async function referenceStatuses(dir: string): Promise<Record<string, ReferenceStatus>> {
  const index = await loadIndex(dir)
  return Object.fromEntries(index.files.map((f) => [f.file, f.status]))
}

/** The converted markdown of a listed, converted reference, or null. */
export async function readConvertedReference(dir: string, file: string): Promise<string | null> {
  if (!isPlainName(file)) return null
  const index = await loadIndex(dir)
  const entry = index.files.find((f) => f.file === file)
  if (!entry || entry.status !== 'converted') return null
  const bytes = await readOrNull(mdPath(dir, file))
  if (bytes === null || sha256(bytes) !== entry.mdSha256) return null
  return bytes.toString('utf8')
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
 * - otherwise BM25 (k1 1.2, b 0.75) over the request's terms, best first,
 *   each chunk that still fits; chunks sharing no term are never sent.
 * A converted copy that no longer matches the index is skipped until the
 * next sync rebuilds it.
 */
export async function queryReferences(
  dir: string,
  text: string,
  maxChars: number,
): Promise<ReferenceChunk[]> {
  const index = await loadIndex(dir)
  const chunks: LiveChunk[] = []
  for (const entry of index.files) {
    if (entry.status !== 'converted') continue
    const bytes = await readOrNull(mdPath(dir, entry.file))
    if (bytes === null || sha256(bytes) !== entry.mdSha256) continue
    const md = bytes.toString('utf8')
    for (const c of entry.chunks) {
      const terms = c.terms && typeof c.terms === 'object' ? c.terms : {}
      chunks.push({
        file: entry.file,
        heading: c.heading,
        text: md.slice(c.offset, c.offset + c.length),
        terms,
        size: Object.values(terms).reduce((n, v) => n + v, 0),
      })
    }
  }
  const plain = (c: LiveChunk): ReferenceChunk => ({
    file: c.file,
    heading: c.heading,
    text: c.text,
  })
  const total = chunks.reduce((n, c) => n + c.text.length, 0)
  if (total <= maxChars) return chunks.map(plain)

  const query = [...new Set(tokenize(text))]
  if (query.length === 0 || chunks.length === 0) return []
  const avg = chunks.reduce((n, c) => n + c.size, 0) / chunks.length || 1
  const idf = new Map<string, number>()
  for (const term of query) {
    const df = chunks.filter((c) => (c.terms[term] ?? 0) > 0).length
    idf.set(term, Math.log(1 + (chunks.length - df + 0.5) / (df + 0.5)))
  }
  const scored = chunks
    .map((c, order) => {
      let score = 0
      for (const term of query) {
        const tf = c.terms[term] ?? 0
        if (tf === 0) continue
        const norm = tf + BM25_K1 * (1 - BM25_B + (BM25_B * c.size) / avg)
        score += (idf.get(term) ?? 0) * ((tf * (BM25_K1 + 1)) / norm)
      }
      return { c, score, order }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
  const picked: ReferenceChunk[] = []
  let used = 0
  for (const { c } of scored) {
    if (used + c.text.length > maxChars) continue
    picked.push(plain(c))
    used += c.text.length
  }
  return picked
}
