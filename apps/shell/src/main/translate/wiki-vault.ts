import type { Lang } from '@genoffice/i18n'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, link, lstat, mkdir, open, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { finalNoteLabels, wikiLabels } from './wiki-vault-labels'

export const FINAL_NOTES_FOLDER = 'final-documents'
export const FINAL_CATALOG = 'final-documents.md'

const categoryFiles = [
  'institutions.md',
  'industries.md',
  'document-types.md',
  'terms.md',
  'style.md',
  'parallel-examples.md',
] as const

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

export async function ensureWikiDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  if (!(await lstat(path)).isDirectory()) throw new Error('Expected a translation wiki directory')
}

async function hasNote(path: string): Promise<boolean> {
  try {
    if (!(await lstat(path)).isFile()) throw new Error('Expected a regular translation wiki note')
    return true
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
}

export async function seedNote(
  stagingDir: string,
  path: string,
  content: string,
): Promise<boolean> {
  if (await hasNote(path)) return false

  // Publish the completed note without replacing one created by Obsidian or another caller.
  // Stage outside the vault so Obsidian never indexes an unfinished note.
  const temp = join(stagingDir, randomUUID() + '.tmp')
  await writeFile(temp, content, { flag: 'wx', mode: 0o600 })
  try {
    try {
      await link(temp, path)
    } catch (error) {
      if (!['EOPNOTSUPP', 'ENOTSUP', 'EPERM', 'EXDEV'].includes(String(errorCode(error))))
        throw error
      await copyFile(temp, path, constants.COPYFILE_EXCL)
    }
  } catch (error) {
    if (errorCode(error) !== 'EEXIST' || !(await hasNote(path))) throw error
    return false
  } finally {
    await unlink(temp)
  }
  return true
}

// An existing vault may predate the catalog or have an edited home page.
let linking = Promise.resolve()
function restoreIndexLinks(indexPath: string, links: [string, string][]): Promise<void> {
  const task = linking.then(async () => {
    const before = await lstat(indexPath, { bigint: true })
    if (!before.isFile()) throw new Error('Expected a regular wiki index')
    const index = await open(
      indexPath,
      constants.O_RDWR | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0),
    )
    try {
      const st = await index.stat({ bigint: true })
      if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino)
        throw new Error('Wiki index changed while opening')
      const current = await index.readFile('utf8')
      const missing = links.filter(
        ([name]) =>
          !current.includes('](' + name + ')') &&
          !current.includes('[[' + name.slice(0, -3) + ']]'),
      )
      if (!missing.length) return
      if (st.nlink !== 1n) throw new Error('Expected a private wiki index')
      await index.appendFile(
        '\n' + missing.map(([name, title]) => '- [' + title + '](' + name + ')').join('\n') + '\n',
      )
    } finally {
      await index.close()
    }
  })
  linking = task.catch(() => {})
  return task
}

export async function prepareTranslationVault(
  profileDir: string,
  lang: Lang,
  repairLinks = false,
): Promise<{ vaultPath: string; indexPath: string }> {
  if (!isAbsolute(profileDir)) throw new Error('Expected an absolute profile directory')
  const wikiDir = join(profileDir, 'translation-wiki')
  const vaultPath = join(wikiDir, 'vault')
  const indexPath = join(vaultPath, 'index.md')
  await ensureWikiDirectory(wikiDir)
  await ensureWikiDirectory(vaultPath)

  const [title, ...labels] = wikiLabels[lang]
  const links = categoryFiles.map((file, index) => `- [${labels[index]}](${file})`)
  for (const [index, file] of categoryFiles.entries()) {
    await seedNote(wikiDir, join(vaultPath, file), `# ${labels[index]}\n\n[${title}](index.md)\n`)
  }
  const catalog = finalNoteLabels[lang][0]
  await seedNote(
    wikiDir,
    join(vaultPath, FINAL_CATALOG),
    '# ' + catalog + '\n\n[' + title + '](index.md)\n',
  )
  links.push('- [' + catalog + '](' + FINAL_CATALOG + ')')
  if (!(await seedNote(wikiDir, indexPath, `# ${title}\n\n${links.join('\n')}\n`))) {
    const required: [string, string][] = repairLinks
      ? categoryFiles.map((file, i) => [file, labels[i]!])
      : [['style.md', labels[4]]]
    required.push([FINAL_CATALOG, catalog])
    await restoreIndexLinks(indexPath, required)
  }
  if (repairLinks) {
    for (const file of [...categoryFiles, FINAL_CATALOG]) {
      await restoreIndexLinks(join(vaultPath, file), [['index.md', title]])
    }
  }
  return { vaultPath, indexPath }
}
