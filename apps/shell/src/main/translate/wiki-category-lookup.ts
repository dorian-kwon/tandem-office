import type { Lang } from '@genoffice/i18n'
import { constants } from 'node:fs'
import { access, lstat, open, opendir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import {
  displayWikiCategory,
  normalizeWikiCategory,
  type WikiClassification,
} from './wiki-classification'
import { CATEGORY_INDEX_MARKER, wikiCategoryAxes, wikiCategoryId } from './wiki-graph'
import { migrateWikiGraph } from './wiki-graph-migrate'
import { FINAL_NOTES_FOLDER, prepareTranslationVault } from './wiki-vault'
import { finalNoteLabels } from './wiki-vault-labels'

type Axis = keyof WikiClassification
type Query = Partial<Record<Axis, string | null>>
const weight: Record<Axis, number> = { institution: 8, industry: 4, documentType: 3, style: 1 }
const excerptHeadings = new Set(Object.values(finalNoteLabels).map(([, label]) => label))
const navigation = /^<!-- tandem:wiki-links -->\r?\n([\s\S]*?)^<!-- \/tandem:wiki-links -->\r?$/m

async function activeVault(profileDir: string) {
  if (!isAbsolute(profileDir)) return
  const profile = await realpath(profileDir)
  const vault = join(profile, 'translation-wiki', 'vault')
  if (relative(vault, await realpath(vault)) === '' && (await lstat(vault)).isDirectory())
    return vault
}

// The graph uses relative links to basenames. User-authored Markdown outside the
// managed section, linked directories, device files and hard links are never sources.
function noteName(href: string): string | undefined {
  try {
    const name = decodeURIComponent(href)
    if (name.length <= 255 && /^[^./\\:\p{Cc}][^/\\:\p{Cc}]*\.md$/iu.test(name)) return name
  } catch {
    /* malformed link */
  }
}

async function readNote(path: string, limit: number, headerOnly = false): Promise<string> {
  try {
    if (relative(path, await realpath(path)) !== '') return ''
    const before = await lstat(path, { bigint: true })
    if (!before.isFile() || before.nlink !== 1n || (!headerOnly && before.size > limit)) return ''
    const file = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    )
    try {
      const stat = await file.stat({ bigint: true })
      if (before.dev !== stat.dev || before.ino !== stat.ino || stat.ctimeNs !== before.ctimeNs)
        return ''
      const bytes = Buffer.alloc(Math.min(limit, Number(stat.size)))
      let offset = 0
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
        if (!bytesRead) return ''
        offset += bytesRead
      }
      if (
        (await file.stat({ bigint: true })).ctimeNs !== stat.ctimeNs ||
        relative(path, await realpath(path)) !== ''
      )
        return ''
      return bytes.toString('utf8')
    } finally {
      await file.close()
    }
  } catch {
    return ''
  }
}

export async function hasWikiCategoryExamples(profileDir: string): Promise<boolean> {
  try {
    const vault = await activeVault(profileDir)
    if (!vault) return false
    await access(vault, constants.R_OK)
    return true
  } catch {
    return false
  }
}

async function hasLearnedNotes(vault: string): Promise<boolean> {
  try {
    const folder = join(vault, FINAL_NOTES_FOLDER)
    if (relative(folder, await realpath(folder)) !== '') return false
    for await (const entry of await opendir(folder)) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
      const header = await readNote(join(folder, entry.name), 512, true)
      if (/^---\r?\nkind: final-style-example\r?\n/.test(header)) return true
    }
  } catch {
    /* No active or readable wiki yet. */
  }
  return false
}

function sampleText(md: string) {
  const lines = md.split(navigation, 1)[0]!.split(/\r?\n/)
  const examples: string[] = []
  let started = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!line) continue
    const heading = /^### (.+) [1-9]\d*$/.exec(line)
    if (
      !heading ||
      !excerptHeadings.has(heading[1]!) ||
      lines[i + 1] !== '' ||
      !lines[i + 2]?.startsWith('    ')
    ) {
      if (started) break
      continue
    }
    started = true
    i += 2
    const value = lines[i]!.slice(4).trim()
    // These are quotation examples. Skip metadata, active Markdown/HTML,
    // role delimiters and common model-directed overrides.
    if (
      value.length > 281 ||
      !/\p{L}/u.test(value) ||
      /[<>`\p{Cc}]|\]\(|\[\[|https?:\/\/|(?:^|\s)(?:system|assistant|developer|publisher|client|industry|document type|issued by|style|발행처|문서\s*종류|산업군|문체|기관명)\s*[:：]/iu.test(
        value,
      ) ||
      /(?:ignore|disregard|override|forget)\b.{0,80}(?:instructions?|prompt|messages?)|(?:instructions?|system prompt)\s*[:：]|(?:지시|명령|프롬프트).{0,25}(?:무시|공개)/i.test(
        value,
      )
    )
      continue
    if (!examples.includes(value)) examples.push(value)
    if (examples.length === 2) break
  }
  return examples
}

async function indexNavigation(vault: string): Promise<{ text: string }> {
  const index = await readNote(join(vault, 'index.md'), 96 * 1024)
  if (!index) return { text: '' }
  const categories = []
  for (const [axis, stem] of wikiCategoryAxes) {
    const path = stem + '.md'
    if (!index.includes('](' + path + ')') && !index.includes('[[' + stem + ']]')) continue
    const page = await readNote(join(vault, path), 1024 * 1024)
    if (!page) continue
    const entries: { name: string; path: string }[] = []
    const links = navigation.exec(page)?.[1] ?? ''
    for (const ref of links.matchAll(
      /^- \[([^\r\n\]]+)\]\(categories\/([^/)]+)\) <!-- tandem:wiki-category-ref ([0-9a-f]{32}) -->\r?$/gm,
    )) {
      const file = noteName(ref[2]!)
      const name = ref[1]!.replace(/&#(\d{1,3});/g, (_, n: string) =>
        String.fromCharCode(Number(n)),
      )
      if (!file || !normalizeWikiCategory(axis, name)) continue
      const header = await readNote(join(vault, 'categories', file), 128, true)
      if (!header.startsWith('<!-- tandem:wiki-category ' + ref[3] + ' -->')) continue
      entries.push({ name, path: 'categories/' + file })
      if (entries.length === 6) break
    }
    categories.push({ axis, path, entries })
  }
  return { text: categories.length ? JSON.stringify({ path: 'index.md', categories }) : '' }
}

/** Read only requested category hubs and a small number of their most closely matched learned notes. */
export async function findWikiCategoryExamples(
  profileDir: string,
  lang: Lang,
  categories: Query,
): Promise<{ text: string }> {
  const empty = { text: '' }
  const vault = await activeVault(profileDir).catch(() => undefined)
  if (!vault) return empty
  if (
    !wikiCategoryAxes.some(
      ([key]) => typeof categories[key] === 'string' && categories[key]?.trim(),
    )
  ) {
    return indexNavigation(vault)
  }
  const matches = new Map<string, Axis[]>()
  const wanted = new Map<Axis, string>()
  let checkedLegacy = false
  for (const [key, axis] of wikiCategoryAxes) {
    const value = normalizeWikiCategory(key, categories[key])
    if (!value) continue
    wanted.set(key, value)
    const hubPath = join(vault, axis + '.md')
    let hub = navigation.exec(await readNote(hubPath, 1024 * 1024))?.[1] ?? ''
    if (!hub.includes(CATEGORY_INDEX_MARKER) && !checkedLegacy) {
      checkedLegacy = true
      if (!(await hasLearnedNotes(vault))) return empty
      // An installed older release can already have learned notes but no graph.
      await prepareTranslationVault(profileDir, lang, true)
      await migrateWikiGraph(vault, lang, true)
      hub = navigation.exec(await readNote(hubPath, 1024 * 1024))?.[1] ?? ''
    }
    const id = wikiCategoryId(axis, value)
    const categoryRef = new RegExp(
      '^-[^\\r\\n]*?\\]\\(categories/([^/)]+)\\) <!-- tandem:wiki-category-ref ' + id + ' -->\\r?$',
      'm',
    ).exec(hub)
    const file = categoryRef && noteName(categoryRef[1]!)
    if (!file) continue
    const page = await readNote(join(vault, 'categories', file), 1024 * 1024)
    if (!page.startsWith('<!-- tandem:wiki-category ' + id + ' -->')) continue
    const links = navigation.exec(page)?.[1] ?? ''
    for (const link of links.matchAll(/^- [^\r\n]*?\]\(\.\.\/final-documents\/([^/)]+)\)\r?$/gm)) {
      const name = noteName(link[1]!)
      if (!name) continue
      const axes = matches.get(name) ?? []
      if (!axes.includes(key)) axes.push(key)
      matches.set(name, axes)
    }
  }
  const score = (axes: Axis[]) => axes.reduce((sum, key) => sum + weight[key], 0)
  const candidates = [...matches].sort(([, a], [, b]) => score(b) - score(a))
  const results: {
    source: string
    path: string
    categories: Record<string, string>
    examples: string[]
  }[] = []
  for (const [name, axes] of candidates.slice(0, 12)) {
    const md = await readNote(join(vault, FINAL_NOTES_FOLDER, name), 96 * 1024)
    const header = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(md)
    if (!header || !/^kind: final-style-example\r?$/m.test(header[1]!)) continue
    const sourceProperty = /^source: ("[^\r\n]*")\r?$/m.exec(header[1]!)
    const scopeProperty = /^<!-- tandem:wiki-scope ([A-Za-z0-9+/=]{1,4096}) -->\r?$/m.exec(
      navigation.exec(md)?.[1] ?? '',
    )
    if (!sourceProperty || !scopeProperty) continue
    let source: unknown, scope: Record<string, unknown>
    try {
      source = JSON.parse(sourceProperty[1]!)
      scope = JSON.parse(Buffer.from(scopeProperty[1]!, 'base64').toString('utf8'))
    } catch {
      continue
    }
    if (
      typeof source !== 'string' ||
      !source ||
      source.length > 255 ||
      /[<>\p{Cc}/\\]/u.test(source) ||
      !scope ||
      typeof scope !== 'object'
    )
      continue
    if (axes.some((key) => normalizeWikiCategory(key, scope[key]) !== wanted.get(key))) continue
    // A known conflicting issuer or sector overrides a broad type/style match.
    if (
      (['institution', 'industry'] as const).some(
        (key) =>
          wanted.has(key) &&
          normalizeWikiCategory(key, scope[key]) &&
          normalizeWikiCategory(key, scope[key]) !== wanted.get(key),
      )
    )
      continue
    const examples = sampleText(md)
    if (!examples.length) continue
    const matched = Object.fromEntries(
      axes.map((key) => [key, displayWikiCategory(lang, key, wanted.get(key)!)]),
    )
    results.push({ source, path: FINAL_NOTES_FOLDER + '/' + name, categories: matched, examples })
    if (results.length === 3) break
  }
  return { text: results.length ? JSON.stringify(results) : '' }
}

/** Open a Markdown page by its vault-relative link. Never enumerate profile folders. */
export async function readTranslationWikiPage(
  profileDir: string,
  vaultRelativePath: string,
): Promise<{ text: string }> {
  const empty = { text: '' }
  if (typeof vaultRelativePath !== 'string' || vaultRelativePath.length > 4096) return empty
  const segments: string[] = []
  for (const encoded of vaultRelativePath.split('/')) {
    let part = encoded
    try {
      part = decodeURIComponent(encoded)
    } catch {
      /* Obsidian also allows literal percent signs. */
    }
    if (
      !part ||
      part.length > 255 ||
      part.startsWith('.') ||
      /[. ]$/.test(part) ||
      /[<>:"/\\|?*\p{Cc}]/u.test(part) ||
      /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part) ||
      part.toLowerCase() === 'translation-wiki-backups'
    )
      return empty
    segments.push(part)
  }
  if (segments.length > 32 || !segments.at(-1)?.toLowerCase().endsWith('.md')) return empty
  const vault = await activeVault(profileDir).catch(() => undefined)
  if (!vault) return empty
  const maxChars = 6000
  const content = await readNote(join(vault, ...segments), maxChars * 4 + 4, true)
  if (!content) return empty
  const markdown = content.slice(0, maxChars).replace(/[\uD800-\uDBFF]$/, '')
  return {
    text: JSON.stringify({
      path: segments.join('/'),
      markdown,
      truncated: markdown.length < content.length,
    }),
  }
}
