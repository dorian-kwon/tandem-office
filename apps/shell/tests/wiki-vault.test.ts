import { LANGS } from '@genoffice/i18n'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prepareTranslationVault } from '../src/main/translate/wiki-vault'

describe('translation wiki vault', () => {
  let temp: string
  let profile: string

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'wiki-vault-'))
    profile = join(temp, '프로필 #1')
  })

  afterEach(async () => {
    await rm(temp, { recursive: true, force: true })
  })

  it.each(LANGS)('creates category and catalog notes and a return link in %s', async (lang) => {
    const { vaultPath, indexPath } = await prepareTranslationVault(profile, lang)
    const index = await readFile(indexPath, 'utf8')
    const title = index.split('\n')[0].slice(2)
    if (lang === 'ko') expect(title).toBe('번역 위키')
    if (lang !== 'en') expect(title).not.toBe('Translation wiki')
    const links = [...index.matchAll(/^- \[([^\]]+)\]\(([a-z-]+\.md)\)$/gm)]
    expect(links).toHaveLength(7)
    expect((await readdir(vaultPath)).sort()).toEqual(
      ['index.md', ...links.map((m) => m[2])].sort(),
    )
    for (const [, label, file] of links) {
      expect(await readFile(join(vaultPath, file), 'utf8')).toContain(
        `# ${label}\n\n[${title}](index.md)\n`,
      )
    }
  })

  it('preserves edited and personal notes even after a locale change and restores a missing category', async () => {
    const { vaultPath, indexPath } = await prepareTranslationVault(profile, 'ko')
    const personal = join(vaultPath, '내 노트.md')
    const terms = join(vaultPath, 'terms.md')
    const style = join(vaultPath, 'style.md')
    await writeFile(indexPath, '내 목차')
    await writeFile(personal, '내 생각')
    await writeFile(terms, '내 용어')
    await unlink(style)
    await prepareTranslationVault(profile, 'en')
    expect(
      await Promise.all([indexPath, personal, terms, style].map((file) => readFile(file, 'utf8'))),
    ).toEqual([
      '내 목차\n- [Style](style.md)\n- [Final documents](final-documents.md)\n',
      '내 생각',
      '내 용어',
      '# Style\n\n[Translation wiki](index.md)\n',
    ])
  })

  it('can initialize concurrently without incomplete notes or temporary files in the vault', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => prepareTranslationVault(profile, 'ko')),
    )
    const { vaultPath, indexPath } = results[0]
    expect(results.every((result) => result.indexPath === indexPath)).toBe(true)
    expect(await readdir(vaultPath)).toHaveLength(8)
    expect((await readFile(indexPath, 'utf8')).match(/^- /gm)).toHaveLength(7)
    expect(await readdir(join(profile, 'translation-wiki'))).toEqual(['vault'])
  })

  it.each(['translation-wiki', 'translation-wiki/vault', 'translation-wiki/vault/terms.md'])(
    'refuses a directory link at %s and leaves the target alone',
    async (relativePath) => {
      const outside = join(temp, 'outside')
      await mkdir(outside)
      const location = join(profile, relativePath)
      await mkdir(join(location, '..'), { recursive: true })
      await symlink(outside, location, 'junction')
      await expect(prepareTranslationVault(profile, 'ko')).rejects.toThrow()
      expect(await readdir(outside)).toEqual([])
    },
  )
})
