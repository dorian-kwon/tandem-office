import type { Lang } from '@genoffice/i18n'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, link, lstat, mkdir, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { wikiLabels } from './wiki-vault-labels'

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

async function ensureDirectory(path: string): Promise<void> {
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

async function seedNote(stagingDir: string, path: string, content: string): Promise<void> {
  if (await hasNote(path)) return

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
  } finally {
    await unlink(temp)
  }
}

export async function prepareTranslationVault(
  profileDir: string,
  lang: Lang,
): Promise<{ vaultPath: string; indexPath: string }> {
  if (!isAbsolute(profileDir)) throw new Error('Expected an absolute profile directory')
  const wikiDir = join(profileDir, 'translation-wiki')
  const vaultPath = join(wikiDir, 'vault')
  const indexPath = join(vaultPath, 'index.md')
  await ensureDirectory(wikiDir)
  await ensureDirectory(vaultPath)

  const [title, ...labels] = wikiLabels[lang]
  const links = categoryFiles.map((file, index) => `- [${labels[index]}](${file})`)
  for (const [index, file] of categoryFiles.entries()) {
    await seedNote(wikiDir, join(vaultPath, file), `# ${labels[index]}\n\n[${title}](index.md)\n`)
  }
  await seedNote(wikiDir, indexPath, `# ${title}\n\n${links.join('\n')}\n`)
  return { vaultPath, indexPath }
}
