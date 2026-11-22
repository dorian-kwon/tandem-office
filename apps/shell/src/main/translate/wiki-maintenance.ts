import type { Lang } from '@genoffice/i18n'
import { withProjectLock } from '@genoffice/translate-project'
import { lstat, mkdtemp, rename, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { migrateWikiGraph } from './wiki-graph-migrate'
import { ensureWikiDirectory, prepareTranslationVault } from './wiki-vault'

/** Hold across the worker lifetime as well as the subsequent graph update. */
export function withWikiAccess<T>(profileDir: string, task: () => Promise<T>): Promise<T> {
  if (!isAbsolute(profileDir)) throw new Error('Expected an absolute profile directory')
  return withProjectLock(join(profileDir, 'translation-wiki'), task)
}

async function existingDirectory(path: string): Promise<boolean> {
  try {
    if (!(await lstat(path)).isDirectory()) throw new Error('Expected a translation wiki directory')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export function maintainTranslationWiki(
  profileDir: string,
  lang: Lang,
  action: 'initialize' | 'repair',
): Promise<void> {
  return withWikiAccess(profileDir, async () => {
    if (action === 'repair') {
      const { vaultPath } = await prepareTranslationVault(profileDir, lang, true)
      await migrateWikiGraph(vaultPath, lang, true)
      return
    }
    if (action !== 'initialize') throw new Error('Unknown translation wiki action')
    // Stage the complete replacement before moving any user files. Moving the
    // whole directory keeps Obsidian settings, attachments and import state together.
    await ensureWikiDirectory(profileDir)
    const active = join(profileDir, 'translation-wiki')
    const existing = await existingDirectory(active)
    if (existing) await existingDirectory(join(active, 'vault'))
    const stage = await mkdtemp(join(profileDir, '.tandem-wiki-'))
    try {
      const { vaultPath } = await prepareTranslationVault(stage, lang)
      await migrateWikiGraph(vaultPath, lang)
      let archive: string | undefined
      if (existing) {
        const backups = join(profileDir, 'translation-wiki-backups')
        await ensureWikiDirectory(backups)
        const stamp = new Date().toISOString().replace(/:/g, '-')
        const backup = await mkdtemp(join(backups, stamp + '-'))
        archive = join(backup, 'translation-wiki')
        await rename(active, archive)
      }
      try {
        await rename(join(stage, 'translation-wiki'), active)
      } catch (error) {
        if (archive && !(await existingDirectory(active))) await rename(archive, active)
        throw error
      }
    } finally {
      await rm(stage, { recursive: true, force: true })
    }
  })
}
