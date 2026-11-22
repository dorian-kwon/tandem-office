import type { Lang } from '@genoffice/i18n'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, win32 } from 'node:path'
import { classifyWikiDocument } from './wiki-classification'
import { finalNoteLabels, wikiLabels } from './wiki-vault-labels'
import {
  FINAL_CATALOG,
  FINAL_NOTES_FOLDER,
  ensureWikiDirectory,
  prepareTranslationVault,
  seedNote,
} from './wiki-vault'

export { FINAL_NOTES_FOLDER } from './wiki-vault'
const MAX_EXAMPLES = 8
const EXCERPT_CHARS = 280
type Example = { line: number; text: string }

/** Never promote parser-generated notices or a reviewer's comments to finished wording. */
function* bodyLines(text: string, ext: string): Generator<Example> {
  let line = 0
  let inAnnotations = false
  for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
    line++
    const value = match[0].trim()
    if (ext === '.pptx' || ext === '.ppt') {
      if (/^## Slide \d+$/.test(value)) {
        inAnnotations = false
        continue
      }
      if (value === '### Notes' || value === '### Comments') inAnnotations = true
    } else if (ext === '.docx' && /^## (Header|Footer|Endnotes|Footnotes|Comments)$/.test(value)) {
      inAnnotations = value === '## Comments'
      continue
    } else if ((ext === '.hwp' || ext === '.hwpx') && value === '### Comments') {
      break
    } else if (['.xlsx', '.xlsm', '.xls'].includes(ext) && value.startsWith('# ')) {
      continue
    }
    if (inAnnotations || !/\p{L}/u.test(value)) continue
    if (
      /^\[No extractable text:|^\[(?:image-only (?:document|sheet)|picture-only slide):|^\[Chapter .* left out:/.test(
        value,
      )
    )
      continue
    // Trim the prefix at a word boundary when possible; line numbers refer to the
    // extractor output, which can flatten tables or join page text onto one line.
    let excerpt = value
    if (excerpt.length > EXCERPT_CHARS) {
      excerpt = excerpt.slice(0, EXCERPT_CHARS).replace(/[\uD800-\uDBFF]$/, '')
      const space = excerpt.lastIndexOf(' ')
      if (space >= EXCERPT_CHARS * 0.7) excerpt = excerpt.slice(0, space)
      excerpt += '…'
    }
    yield { line, text: excerpt }
  }
}

/** Spread the examples across the document, keeping only the selected excerpts in memory. */
function examplesOf(text: string, ext: string) {
  let count = 0
  let head = ''
  let tail = ''
  for (const { text: line } of bodyLines(text, ext)) {
    count++
    if (head.length < 8192) head += line + '\n'
    else tail = (tail + line + '\n').slice(-2048)
  }
  const total = Math.min(count, MAX_EXAMPLES)
  const wanted = new Set(
    Array.from({ length: total }, (_, i) => Math.round((i * (count - 1)) / Math.max(1, total - 1))),
  )
  const selected: Example[] = []
  let index = 0
  for (const example of bodyLines(text, ext)) {
    if (wanted.has(index++) && !selected.some((s) => s.text === example.text))
      selected.push(example)
  }
  return { examples: selected, sample: head + tail }
}

// Only this delimited block and the machine-written revision change on a new result.
// A missing or ambiguous marker means the owner has reorganized the note: leave it intact.
const END_EXAMPLES = '<!-- /tandem:project-examples -->'

async function readPrivateNote(path: string, maxBytes?: number) {
  const previous = await lstat(path, { bigint: true })
  if (!previous.isFile() || previous.nlink !== 1n || (maxBytes && previous.size > maxBytes))
    throw new Error('Expected a regular wiki note')
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  )
  try {
    const opened = await file.stat({ bigint: true })
    if (opened.dev !== previous.dev || opened.ino !== previous.ino)
      throw new Error('Wiki note changed while opening')
    return { previous, content: await file.readFile('utf8') }
  } finally {
    await file.close()
  }
}

async function replacePrivateNote(
  path: string,
  stagingDir: string,
  next: string,
  previous: Awaited<ReturnType<typeof readPrivateNote>>['previous'],
) {
  const temp = join(stagingDir, randomUUID() + '.tmp')
  await writeFile(temp, next, { flag: 'wx', mode: 0o600 })
  try {
    const current = await lstat(path, { bigint: true })
    if (
      current.dev !== previous.dev ||
      current.ino !== previous.ino ||
      current.ctimeNs !== previous.ctimeNs
    )
      throw new Error('Wiki note was edited during import')
    await rename(temp, path)
  } finally {
    await unlink(temp).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

async function refreshManagedNote(
  path: string,
  stagingDir: string,
  key: string,
  digest: string,
  name: string,
  generated: string,
): Promise<'updated' | 'duplicate'> {
  const { previous, content } = await readPrivateNote(path)
  const start = new RegExp(
    '^<!-- tandem:project-examples ' + key + ' ([0-9a-f]{64}) ([A-Za-z0-9+/=]+) -->\\r?$',
    'gm',
  )
  const starts = [...content.matchAll(start)]
  const ends = [...content.matchAll(/^<!-- \/tandem:project-examples -->\r?$/gm)]
  if (starts.length !== 1 || ends.length !== 1 || starts[0]!.index! > ends[0]!.index!)
    throw new Error('Project example markers have changed')
  const previousDigest = starts[0]![1]
  const previousName = Buffer.from(starts[0]![2], 'base64').toString('utf8')
  if (previousDigest === digest && previousName === name) return 'duplicate'
  const begin = starts[0]!.index!
  const end = ends[0]!.index!
  const newline = starts[0]![0].endsWith('\r') ? '\r\n' : '\n'
  const header = content
    .slice(0, begin)
    .replace(/^---\r?\n[\s\S]*?^---\r?$/m, (yaml, offset: number) => {
      if (offset !== 0) return yaml
      return yaml.replace(/^(revision|source): [^\r\n]*$/gm, (line) => {
        if (line === 'revision: ' + previousDigest) return 'revision: ' + digest
        if (line === 'source: ' + JSON.stringify(previousName))
          return 'source: ' + JSON.stringify(name)
        return line
      })
    })
  const block =
    previousDigest === digest
      ? generated.slice(0, generated.indexOf('\n')) +
        content.slice(begin + starts[0]![0].trimEnd().length, end + END_EXAMPLES.length)
      : generated.replaceAll('\n', newline)
  const next = header + block + content.slice(end + END_EXAMPLES.length)
  await replacePrivateNote(path, stagingDir, next, previous)
  return previousDigest === digest ? 'duplicate' : 'updated'
}

async function readOptionalNote(path: string, maxBytes?: number) {
  try {
    return await readPrivateNote(path, maxBytes)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

// v0.15.12 kept the content revision but did not keep the path of a home import.
// Bind only an exact match. Keep its original filename for links, including links
// outside this vault. The private alias stores a digest, never the source path.
async function resolveHomeNote(
  defaultPath: string,
  vault: string,
  stem: string,
  key: string,
  digest: string,
  name: string,
  generated: string,
): Promise<string | undefined> {
  const staging = dirname(vault)
  const links = join(vault, '.tandem-source-links')
  await ensureWikiDirectory(links)
  const alias = join(links, key)
  const legacyPath = (suffix: string) => join(dirname(defaultPath), stem + '-' + suffix + '.md')
  const existing = await readOptionalNote(alias, 20)
  if (existing) {
    if (!/^[0-9a-f]{20}$/.test(existing.content)) throw new Error('Invalid wiki source identity')
    return legacyPath(existing.content)
  }
  // A managed copy already exists even when this revision also has an older unbound note.
  try {
    await lstat(defaultPath)
    return defaultPath
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const suffix = digest.slice(0, 20)
  const path = legacyPath(suffix)
  const old = await readOptionalNote(path)
  if (!old) return defaultPath
  const startMarker = generated.slice(0, generated.indexOf('\n'))
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(old.content)
  if (!header) return undefined
  const fields = header[1]!.split(/\r?\n/)
  if (
    !['kind: final-style-example', 'source: ' + JSON.stringify(name), 'revision: ' + digest].every(
      (line) => fields.includes(line),
    )
  )
    return undefined
  const marker = /^<!-- tandem:project-examples .* -->\r?$/m.exec(old.content)
  if (marker) {
    // Recover an interrupted bind only if this exact source already owns the note.
    if (marker[0].trimEnd() !== startMarker) return defaultPath
  } else {
    const newline = old.content.includes('\r\n') ? '\r\n' : '\n'
    const headings = Object.values(finalNoteLabels)
      .map(([, label]) => label)
      .join('|')
    const row = '(?:' + headings + ') [0-9]+\\r?\\n\\r?\\n    [^\\r\\n]+'
    const blocks = [
      ...old.content.matchAll(
        new RegExp('^### ' + row + '(?:\\r?\\n\\r?\\n### ' + row + ')*', 'gm'),
      ),
    ]
    // A manually reorganized note has no safe replacement boundary.
    if (blocks.length !== 1 || old.content.includes(END_EXAMPLES)) return undefined
    const block = blocks[0]!
    const before = old.content.slice(0, block.index)
    const classification = generated.split('\n')[1]!
    const headerText = before.replace(
      /(?<=\n)<!-- tandem:wiki-classification [A-Za-z0-9+/=]+ -->\r?\n$/,
      '',
    )
    const next =
      headerText +
      [startMarker, classification, block[0], END_EXAMPLES].join(newline) +
      old.content.slice(block.index! + block[0].length)
    await replacePrivateNote(path, staging, next, old.previous)
  }
  if (!(await seedNote(staging, alias, suffix))) {
    if ((await readPrivateNote(alias, 20)).content !== suffix)
      throw new Error('Wiki source identity changed during import')
  }
  return path
}

export async function ingestFinalNote(
  profileDir: string,
  lang: Lang,
  fileName: string,
  extractedText: string,
  revision?: string,
  projectDir?: string,
  outputName?: string,
  sourcePath?: string,
): Promise<'added' | 'updated' | 'duplicate' | 'empty'> {
  const name = basename(win32.basename(fileName)).normalize('NFC')
  const logicalName =
    projectDir && outputName ? basename(win32.basename(outputName)).normalize('NFC') : name
  const ext = extname(name).toLowerCase()
  const { examples, sample } = examplesOf(extractedText, ext)
  if (!examples.length) return 'empty'

  const digest = createHash('sha256')
    .update(logicalName)
    .update('\0')
    .update(revision ?? extractedText)
    .digest('hex')
  const { vaultPath } = await prepareTranslationVault(profileDir, lang)
  const stagingDir = dirname(vaultPath)
  const folder = join(vaultPath, FINAL_NOTES_FOLDER)
  await ensureWikiDirectory(folder)
  const [catalog, lineLabel] = finalNoteLabels[lang]
  const style = wikiLabels[lang][5]

  const stem = logicalName
    .slice(0, 60)
    .replace(/[^\p{L}\p{M}\p{N} -]/gu, '_')
    .trim()
  // Project roots arrive canonicalized by the main process. Keep their private
  // absolute paths out of note metadata and independent of manually imported notes.
  const projectKey = projectDir
    ? createHash('sha256')
        .update('project\0')
        .update(process.platform === 'win32' ? projectDir.toLowerCase() : projectDir)
        .update('\0')
        .update(logicalName)
        .digest('hex')
    : undefined
  const homeKey =
    !projectDir && sourcePath
      ? createHash('sha256')
          .update('home\0')
          .update(process.platform === 'win32' ? sourcePath.toLowerCase() : sourcePath)
          .digest('hex')
      : undefined
  const key = projectKey ?? homeKey
  const suffix = key
    ? (projectKey ? 'project-' : 'source-') + key.slice(0, 20)
    : digest.slice(0, 20)
  let path = join(folder, (stem || 'document') + '-' + suffix + '.md')
  const classification = classifyWikiDocument(logicalName, sample)
  const classificationMarker = Buffer.from(JSON.stringify(classification)).toString('base64')
  const samples =
    '<!-- tandem:wiki-classification ' +
    classificationMarker +
    ' -->\n' +
    examples
      .flatMap(({ line, text }) => ['### ' + lineLabel + ' ' + line, '', '    ' + text, ''])
      .join('\n')
  const generated = key
    ? '<!-- tandem:project-examples ' +
      key +
      ' ' +
      digest +
      ' ' +
      Buffer.from(name).toString('base64') +
      ' -->\n' +
      samples +
      '\n' +
      END_EXAMPLES
    : samples
  // Source text belongs in literal blocks so a link, image or Markdown command
  // in a finished document cannot become active content of a generated note.
  const heading = logicalName.replace(/[^\p{L}\p{M}\p{N} ]/gu, (c) => '&#' + c.codePointAt(0) + ';')
  const note = [
    '---',
    'kind: final-style-example',
    'source: ' + JSON.stringify(name),
    'revision: ' + digest,
    'source_format: ' + JSON.stringify(ext.slice(1)),
    // Leave scope properties available in Obsidian until the reader can verify them.
    'institution: null',
    'industry: null',
    'document_type: null',
    'style: null',
    'source_language: null',
    'target_language: null',
    '---',
    '# ' + heading,
    '',
    '[' + catalog + '](../' + FINAL_CATALOG + ') · [' + style + '](../style.md)',
    '',
    generated,
    '',
  ].join('\n')
  if (homeKey) {
    const resolved = await resolveHomeNote(
      path,
      vaultPath,
      stem || 'document',
      homeKey,
      digest,
      name,
      generated,
    )
    if (!resolved) return 'duplicate'
    path = resolved
  }
  if (await seedNote(stagingDir, path, note)) return 'added'
  if (!key) return 'duplicate'
  return refreshManagedNote(path, stagingDir, key, digest, name, generated)
}
