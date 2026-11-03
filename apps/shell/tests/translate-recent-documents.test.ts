import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createProject } from '@genoffice/translate-project'
import { readAppSettings, writeTranslationProjects } from '../src/main/app-settings'
import {
  listRecentDocuments,
  recordRecentDocument,
  RECENT_DOCUMENTS_LIMIT,
} from '../src/main/translate/recent-documents'

let root: string
let settingsPath: string
let dir: string

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'translate-recent-'))
  settingsPath = join(root, 'app-settings.json')
  dir = (await createProject(root, 'Demo', 'ko', 'en')).dir
  writeTranslationProjects(settingsPath, [{ dir, lastOpened: 1 }])
  writeFileSync(join(dir, 'output', 'a.md'), 'x')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('recent translation documents', () => {
  it('lists newest first with project name and languages', async () => {
    writeFileSync(join(dir, 'output', 'b.md'), 'x')
    recordRecentDocument(settingsPath, { dir, file: 'a.md', output: 'a.md' }, 100)
    recordRecentDocument(settingsPath, { dir, file: 'b.md', output: 'b.md' }, 200)
    const list = await listRecentDocuments(settingsPath)
    expect(list.map((r) => r.file)).toEqual(['b.md', 'a.md'])
    expect(list[0]).toEqual({
      dir,
      projectName: 'Demo',
      file: 'b.md',
      sourceLang: 'ko',
      targetLang: 'en',
      openedAt: 200,
      available: true,
    })
  })

  it('keeps one entry per project and file, moved to the top', async () => {
    writeFileSync(join(dir, 'output', 'b.md'), 'x')
    recordRecentDocument(settingsPath, { dir, file: 'a.md', output: 'a.md' }, 100)
    recordRecentDocument(settingsPath, { dir, file: 'b.md', output: 'b.md' }, 200)
    recordRecentDocument(settingsPath, { dir, file: 'a.md', output: 'a.md' }, 300)
    const list = await listRecentDocuments(settingsPath)
    expect(list.map((r) => [r.file, r.openedAt])).toEqual([
      ['a.md', 300],
      ['b.md', 200],
    ])
  })

  it('keeps at most 10 entries', async () => {
    for (let i = 0; i < 15; i++)
      recordRecentDocument(settingsPath, { dir, file: `f${i}.md`, output: `f${i}.md` }, i + 1)
    const list = await listRecentDocuments(settingsPath)
    expect(list).toHaveLength(RECENT_DOCUMENTS_LIMIT)
    expect(list[0].file).toBe('f14.md')
    expect(list[9].file).toBe('f5.md')
    expect((readAppSettings(settingsPath).translationRecentDocuments as unknown[]).length).toBe(10)
  })

  it('drops entries of projects no longer registered', async () => {
    recordRecentDocument(settingsPath, { dir, file: 'a.md', output: 'a.md' }, 100)
    writeTranslationProjects(settingsPath, [])
    expect(await listRecentDocuments(settingsPath)).toEqual([])
  })

  it('marks an entry unavailable when the output file or the folder is gone', async () => {
    recordRecentDocument(settingsPath, { dir, file: 'a.md', output: 'a.md' }, 100)
    recordRecentDocument(settingsPath, { dir, file: 'gone.md', output: 'gone.md' }, 200)
    let list = await listRecentDocuments(settingsPath)
    expect(list.map((r) => [r.file, r.available])).toEqual([
      ['gone.md', false],
      ['a.md', true],
    ])
    rmSync(dir, { recursive: true, force: true })
    list = await listRecentDocuments(settingsPath)
    expect(list.every((r) => !r.available)).toBe(true)
    expect(list[0].projectName).toBe('Demo')
  })

  it('ignores damaged stored values and unsafe names', async () => {
    mkdirSync(join(dir, 'output', 'sub'))
    recordRecentDocument(settingsPath, { dir, file: '../x', output: 'a.md' }, 100)
    recordRecentDocument(settingsPath, { dir, file: 'a.md', output: '../a.md' }, 100)
    expect(await listRecentDocuments(settingsPath)).toEqual([])
    writeFileSync(settingsPath, JSON.stringify({ translationRecentDocuments: 'nope' }))
    expect(await listRecentDocuments(settingsPath)).toEqual([])
  })
})
