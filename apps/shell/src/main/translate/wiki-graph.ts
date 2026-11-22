import type { Lang } from '@genoffice/i18n'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  classifyWikiDocument,
  displayWikiCategory,
  normalizeWikiCategory,
  type WikiClassification,
} from './wiki-classification'
import { wikiLabels } from './wiki-vault-labels'
import { ensureWikiDirectory, FINAL_CATALOG, FINAL_NOTES_FOLDER, seedNote } from './wiki-vault'

const START = '<!-- tandem:wiki-links -->'
const END = '<!-- /tandem:wiki-links -->'
export const CATEGORY_INDEX_MARKER = '<!-- tandem:wiki-category-index v1 -->'
export const wikiCategoryAxes = [
  ['documentType', 'document-types', 3],
  ['industry', 'industries', 2],
  ['institution', 'institutions', 1],
  ['style', 'style', 5],
] as const

export function wikiCategoryId(axis: string, value: string): string {
  return createHash('sha256')
    .update(axis + '\0' + value.normalize('NFC'))
    .digest('hex')
    .slice(0, 32)
}

function escapeLabel(label: string): string {
  return label
    .replace(/[\r\n]/g, ' ')
    .replace(/[\\[\]<>*_|`&]/g, (c) => '&#' + c.charCodeAt(0) + ';')
}

function mdLink(label: string, path: string): string {
  const href = path
    .split('/')
    .map((part) => encodeURIComponent(part).replaceAll('(', '%28').replaceAll(')', '%29'))
    .join('/')
  return '[' + escapeLabel(label) + '](' + href + ')'
}

// The app writes scalar properties in this header. Read only the requested scalar.
function property(header: string, key: string): string | undefined {
  const raw = new RegExp('^' + key + ':[ \\t]*([^\\r\\n]*)$', 'm').exec(header)?.[1]?.trim()
  if (!raw || raw === 'null' || raw === '~') return
  if (raw.startsWith('"')) {
    try {
      const decoded: unknown = JSON.parse(raw)
      return typeof decoded === 'string' ? decoded : undefined
    } catch {
      return
    }
  }
  return raw.replace(/^'(.*)'$/, '$1').replaceAll("''", "'")
}

async function noteAt(path: string) {
  const before = await lstat(path, { bigint: true })
  if (!before.isFile() || before.nlink !== 1n) throw new Error('Expected a private wiki note')
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  )
  try {
    const opened = await handle.stat({ bigint: true })
    if (opened.ino !== before.ino || opened.dev !== before.dev)
      throw new Error('Wiki note changed while opening')
    return { path, before, text: await handle.readFile('utf8') }
  } finally {
    await handle.close()
  }
}

type Note = Awaited<ReturnType<typeof noteAt>>

async function updateLinks(vault: string, note: Note, links: string[]) {
  const newline = note.text.includes('\r\n') ? '\r\n' : '\n'
  const block = [START, ...links, END].join(newline)
  const starts = [...note.text.matchAll(/^<!-- tandem:wiki-links -->\r?$/gm)]
  const ends = [...note.text.matchAll(/^<!-- \/tandem:wiki-links -->\r?$/gm)]
  if (
    starts.length !== ends.length ||
    starts.length > 1 ||
    (starts.length && starts[0]!.index! > ends[0]!.index!)
  )
    throw new Error('Wiki navigation markers were edited')
  const text = starts.length
    ? note.text.slice(0, starts[0]!.index) + block + note.text.slice(ends[0]!.index! + END.length)
    : note.text + newline + block + newline
  if (text === note.text) return
  const temp = join(dirname(vault), randomUUID() + '.tmp')
  await writeFile(temp, text, { mode: 0o600, flag: 'wx' })
  try {
    const now = await lstat(note.path, { bigint: true })
    if (
      now.dev !== note.before.dev ||
      now.ino !== note.before.ino ||
      now.ctimeNs !== note.before.ctimeNs
    )
      throw new Error('Wiki note was edited during indexing')
    await rename(temp, note.path)
  } finally {
    await unlink(temp).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

interface Entry {
  file: string
  title: string
}
interface Category {
  id: string
  file: string
  title: string
  axis: string
  entries: Entry[]
}

export async function syncWikiGraph(
  vault: string,
  paths: readonly string[],
  lang: Lang,
): Promise<void> {
  const directory = join(vault, 'categories')
  await ensureWikiDirectory(directory)
  const labels = wikiLabels[lang]
  const categories = new Map<string, Category>()
  const directoryFiles = await readdir(directory, { withFileTypes: true })
  const usedNames = new Set(
    directoryFiles.map((entry) => entry.name.normalize('NFC').toLowerCase()),
  )
  const known = new Map<string, string>()
  for (const file of directoryFiles) {
    if (!file.isFile() || !file.name.endsWith('.md')) continue
    const note = await noteAt(join(directory, file.name))
    const key = /^<!-- tandem:wiki-category ([0-9a-f]{32}) -->\r?$/m.exec(note.text)?.[1]
    if (key) known.set(key, file.name)
  }
  const entries: Entry[] = []
  for (const path of paths) {
    if (dirname(path) !== join(vault, FINAL_NOTES_FOLDER))
      throw new Error('Unexpected wiki note path')
    const note = await noteAt(path)
    const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(note.text)
    if (!header || property(header[1]!, 'kind') !== 'final-style-example') continue
    const title = property(header[1]!, 'source') || basename(path, '.md')
    const entry = { file: basename(path), title }
    entries.push(entry)
    // Only the literal examples come from the source. Ignore previous navigation and personal notes.
    const body = [...note.text.matchAll(/^ {4}(.+)$/gm)].map((match) => match[1]!).join('\n')
    const meta = {
      documentType: property(header[1]!, 'document_type'),
      industry: property(header[1]!, 'industry'),
      institution: property(header[1]!, 'institution'),
      style: property(header[1]!, 'style'),
    }
    const classification = classifyWikiDocument(title, body, meta)
    // Newer notes keep the bounded source analysis, older ones have only their excerpts.
    const marker = /^<!-- tandem:wiki-classification ([A-Za-z0-9+/=]+) -->\r?$/m.exec(note.text)
    let inferred: Record<string, unknown> = {}
    if (marker) {
      try {
        const saved = JSON.parse(Buffer.from(marker[1]!, 'base64').toString('utf8'))
        if (saved && typeof saved === 'object') inferred = saved
      } catch {
        /* A manually edited marker falls back to the visible excerpts. */
      }
    }
    const scope: Partial<Record<keyof WikiClassification, string>> = {}
    const links = [mdLink(labels[0], '../index.md')]
    for (const [key, axis, labelIndex] of wikiCategoryAxes) {
      const value = meta[key]
        ? classification[key]
        : (normalizeWikiCategory(key, inferred[key]) ?? classification[key])
      if (!value) continue
      const label = displayWikiCategory(lang, key, value)
      if (key !== 'documentType' || value !== 'unclassified') scope[key] = label
      const id = wikiCategoryId(axis, value)
      let category = categories.get(id)
      if (!category) {
        // Obsidian labels graph nodes with filenames. Keep a readable name across language changes.
        const clean =
          Array.from(
            label
              .normalize('NFC')
              .replace(/[^\p{L}\p{M}\p{N} -]/gu, ' ')
              .trim(),
          )
            .slice(0, 50)
            .join('') || axis
        const stem = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(clean)
          ? clean + ' ' + axis
          : clean
        let file = known.get(id)
        if (!file) {
          file = stem + '.md'
          let number = 1
          while (usedNames.has(file.toLowerCase())) file = stem + ' (' + ++number + ').md'
          usedNames.add(file.toLowerCase())
        }
        category = { id, file, title: label, axis, entries: [] }
        categories.set(id, category)
      }
      category.entries.push(entry)
      links.push(labels[labelIndex] + ' · ' + mdLink(label, '../categories/' + category.file))
    }
    const scopeMarker = Buffer.from(JSON.stringify(scope)).toString('base64')
    await updateLinks(vault, note, [
      '<!-- tandem:wiki-scope ' + scopeMarker + ' -->',
      ...links.map((link) => '- ' + link),
    ])
  }
  const sorted = <T extends { title: string }>(list: T[]) =>
    list.sort((a, b) => a.title.localeCompare(b.title, lang))
  const listing = (docs: Entry[], prefix: string) =>
    sorted(docs).map(
      (doc) => '- ' + mdLink(doc.title, prefix + FINAL_NOTES_FOLDER + '/' + doc.file),
    )
  for (const [key, group] of categories) {
    const path = join(directory, group.file)
    await seedNote(
      dirname(vault),
      path,
      '<!-- tandem:wiki-category ' + key + ' -->\n# ' + escapeLabel(group.title) + '\n',
    )
    const axis = wikiCategoryAxes.find((axis) => axis[1] === group.axis)!
    await updateLinks(vault, await noteAt(path), [
      mdLink(labels[axis[2]], '../' + group.axis + '.md') +
        ' · ' +
        mdLink(labels[0], '../index.md'),
      '',
      ...listing(group.entries, '../'),
    ])
  }
  for (const [id, file] of known) {
    if (categories.has(id)) continue
    const note = await noteAt(join(directory, file))
    await updateLinks(vault, note, [mdLink(labels[0], '../index.md')])
  }
  for (const [, axis] of wikiCategoryAxes) {
    const groups = sorted([...categories.values()].filter((group) => group.axis === axis))
    await updateLinks(vault, await noteAt(join(vault, axis + '.md')), [
      CATEGORY_INDEX_MARKER,
      ...groups.map(
        (group) =>
          '- ' +
          mdLink(group.title, 'categories/' + group.file) +
          ' <!-- tandem:wiki-category-ref ' +
          group.id +
          ' -->',
      ),
    ])
  }
  await updateLinks(vault, await noteAt(join(vault, FINAL_CATALOG)), listing(entries, ''))
}
