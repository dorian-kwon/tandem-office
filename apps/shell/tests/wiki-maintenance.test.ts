import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { maintainTranslationWiki, withWikiAccess } from '../src/main/translate/wiki-maintenance'
import { prepareTranslationVault } from '../src/main/translate/wiki-vault'

let profile: string
beforeEach(async () => {
  profile = await mkdtemp(join(tmpdir(), 'tandem-wiki-maintenance-'))
})
afterEach(async () => {
  await rm(profile, { recursive: true, force: true })
})

it('repairs an old vault, reconstructs reciprocal links for shared categories and keeps personal edits', async () => {
  const { vaultPath, indexPath } = await prepareTranslationVault(profile, 'ko')
  const notes = join(vaultPath, 'final-documents')
  await mkdir(notes)
  for (const name of ['부산', '서울']) {
    await writeFile(
      join(notes, name + '.md'),
      '---\nkind: final-style-example\nsource: "' + name + ' 안내서.docx"\n---\n개인 메모\n',
    )
  }
  const personal = join(vaultPath, '연구.md')
  await writeFile(personal, '내 메모')
  await unlink(indexPath)
  await unlink(join(vaultPath, 'style.md'))
  await maintainTranslationWiki(profile, 'ko', 'repair')
  const types = join(vaultPath, 'document-types.md')
  const category = join(vaultPath, 'categories', '안내서.md')
  const one = join(notes, '부산.md')
  const read = (path: string) => readFile(path, 'utf8')
  expect(await read(indexPath)).toContain('(document-types.md)')
  expect(decodeURIComponent(await read(types))).toContain('(categories/안내서.md)')
  expect(decodeURIComponent(await read(one))).toContain('(../categories/안내서.md)')
  const related = decodeURIComponent(await read(category))
  for (const name of ['부산', '서울'])
    expect(related).toContain('(../final-documents/' + name + '.md)')
  // Obsidian can edit a category without changing its containing folder's metadata.
  await writeFile(category, (await read(category)).replace(/^- \[.*$/gm, '') + '분류 메모\n')
  await maintainTranslationWiki(profile, 'ko', 'repair')
  expect(decodeURIComponent(await read(category))).toContain('(../final-documents/부산.md)')
  expect(await read(category)).toContain('분류 메모')
  await writeFile(indexPath, '내 목차\n')
  await writeFile(types, '분류별 목차\n')
  await maintainTranslationWiki(profile, 'ko', 'repair')
  const repaired = await read(indexPath)
  expect(repaired).toContain('내 목차')
  expect(repaired.match(/^- \[/gm)).toHaveLength(7)
  expect(await read(types)).toContain('(index.md)')
  await maintainTranslationWiki(profile, 'ko', 'repair')
  expect(await read(indexPath)).toBe(repaired)
  expect(await read(one)).toContain('개인 메모')
  expect(await read(personal)).toBe('내 메모')
})

it('initializes after pending learning, keeping the whole previous vault and its state together', async () => {
  const { vaultPath } = await prepareTranslationVault(profile, 'en')
  const config = join(vaultPath, '.obsidian')
  await mkdir(config)
  await writeFile(join(config, 'app.json'), '{}')
  const active = join(profile, 'translation-wiki')
  await writeFile(join(active, 'state.json'), '{"previous":true}')
  let finishLearning!: () => void
  const gate = new Promise<void>((resolve) => {
    finishLearning = resolve
  })
  const learning = withWikiAccess(profile, async () => {
    await gate
    await writeFile(join(vaultPath, 'Personal.md'), 'My notes')
  })
  const initialize = maintainTranslationWiki(profile, 'en', 'initialize')
  finishLearning()
  await Promise.all([learning, initialize])
  expect(await readdir(vaultPath)).not.toContain('Personal.md')
  expect(await readdir(active)).not.toContain('state.json')
  expect(await readFile(join(vaultPath, 'index.md'), 'utf8')).toContain('(document-types.md)')
  const backups = join(profile, 'translation-wiki-backups')
  const names = await readdir(backups)
  expect(names).toHaveLength(1)
  const previous = join(backups, names[0]!, basename(active))
  expect(await readFile(join(previous, 'state.json'), 'utf8')).toBe('{"previous":true}')
  expect(await readFile(join(previous, 'vault', 'Personal.md'), 'utf8')).toBe('My notes')
  expect(await readFile(join(previous, 'vault', '.obsidian', 'app.json'), 'utf8')).toBe('{}')
})

it('can initialize a new profile without creating a backup and refuses redirected backup or vault roots', async () => {
  await maintainTranslationWiki(profile, 'en', 'initialize')
  expect(await readdir(profile)).toEqual(['translation-wiki'])
  const active = join(profile, 'translation-wiki')
  const outside = join(profile, 'outside')
  await mkdir(outside)
  await symlink(outside, join(profile, 'translation-wiki-backups'), 'junction')
  await expect(maintainTranslationWiki(profile, 'en', 'initialize')).rejects.toThrow()
  expect(await readdir(outside)).toEqual([])
  await rm(join(active, 'vault'), { recursive: true })
  await symlink(outside, join(active, 'vault'), 'junction')
  await expect(maintainTranslationWiki(profile, 'en', 'repair')).rejects.toThrow()
  await expect(maintainTranslationWiki(profile, 'en', 'initialize')).rejects.toThrow()
  expect(await readdir(outside)).toEqual([])
})
