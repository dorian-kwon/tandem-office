import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { syncWikiGraph } from '../src/main/translate/wiki-graph'
import { migrateWikiGraph } from '../src/main/translate/wiki-graph-migrate'
import { prepareTranslationVault, FINAL_NOTES_FOLDER } from '../src/main/translate/wiki-vault'

vi.mock('../src/main/translate/wiki-graph', () => ({ syncWikiGraph: vi.fn() }))

describe('existing translation wiki graph migration', () => {
  let profile: string, vault: string, notes: string
  const sync = vi.mocked(syncWikiGraph)
  beforeEach(async () => {
    profile = await mkdtemp(join(tmpdir(), 'wiki-graph-migration-'))
    vault = (await prepareTranslationVault(profile, 'ko')).vaultPath
    notes = join(vault, FINAL_NOTES_FOLDER)
    await mkdir(notes, { recursive: true })
    sync.mockReset()
    sync.mockResolvedValue(undefined)
  })
  afterEach(async () => {
    await rm(profile, { recursive: true, force: true })
  })

  it('refreshes renamed, edited and deleted notes, and skips unchanged vaults after restart', async () => {
    const a = join(notes, 'A.md'),
      b = join(notes, 'B.md')
    await writeFile(a, 'A')
    await writeFile(b, 'B')
    sync.mockImplementationOnce(async () => {
      await writeFile(a, 'A with generated backlinks')
    })
    await Promise.all([migrateWikiGraph(vault, 'ko'), migrateWikiGraph(vault, 'ko')])
    expect(sync).toHaveBeenCalledTimes(2)
    expect(sync).toHaveBeenLastCalledWith(vault, [a, b], 'ko')
    await writeFile(b, 'industry: tourism')
    await migrateWikiGraph(vault, 'ko')
    expect(sync).toHaveBeenCalledTimes(3)
    expect(sync).toHaveBeenLastCalledWith(vault, [a, b], 'ko')
    await unlink(a)
    await unlink(b)
    await migrateWikiGraph(vault, 'ko')
    expect(sync).toHaveBeenLastCalledWith(vault, [], 'ko')
    await migrateWikiGraph(vault, 'en')
    expect(sync).toHaveBeenLastCalledWith(vault, [], 'en')
  })

  it('includes a note created while an earlier snapshot is being linked', async () => {
    const added = join(notes, 'late.md')
    sync.mockImplementationOnce(async () => {
      await writeFile(added, 'new example')
    })
    await migrateWikiGraph(vault, 'ko')
    expect(sync).toHaveBeenCalledTimes(2)
    expect(sync).toHaveBeenLastCalledWith(vault, [added], 'ko')
    await migrateWikiGraph(vault, 'ko')
    expect(sync).toHaveBeenCalledTimes(2)
  })

  it('repairs hubs and categories removed in Obsidian', async () => {
    const categories = join(vault, 'categories')
    const detail = join(categories, 'City.md')
    await mkdir(categories)
    await writeFile(detail, 'City')
    await migrateWikiGraph(vault, 'ko')
    await unlink(detail)
    await migrateWikiGraph(vault, 'ko')
    await writeFile(join(vault, 'institutions.md'), '')
    await migrateWikiGraph(vault, 'ko')
    expect(sync).toHaveBeenCalledTimes(3)
  })

  it('retries after a failed or interrupted sync', async () => {
    await writeFile(join(notes, 'A.md'), 'A')
    sync.mockRejectedValueOnce(new Error('busy'))
    await expect(migrateWikiGraph(vault, 'ko')).rejects.toThrow('busy')
    await migrateWikiGraph(vault, 'ko')
    expect(sync).toHaveBeenCalledTimes(2)
    const cache = join(profile, 'translation-wiki', 'wiki-graph-migration-v1.json')
    expect(JSON.parse(await readFile(cache, 'utf8')).signature).toMatch(/^[a-f0-9]{64}$/)
    await writeFile(cache, '{')
    await migrateWikiGraph(vault, 'ko')
    expect(sync).toHaveBeenCalledTimes(3)
  })

  it('will not let a replacement folder redirect a vault scan', async () => {
    await rm(notes, { recursive: true })
    const outside = join(profile, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'Private.md'), 'unrelated')
    await symlink(outside, notes, 'junction')
    await expect(migrateWikiGraph(vault, 'ko')).rejects.toThrow()
    expect(sync).not.toHaveBeenCalled()
  })
})
