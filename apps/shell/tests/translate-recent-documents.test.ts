import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createProject, loadProject, saveProject } from '@genoffice/translate-project'
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
  async function withSource(name: string) {
    writeFileSync(join(dir, 'source', name), 'x')
    const project = await loadProject(dir)
    project.sources.push({ file: name, kind: 'editable', sha256: 'h' })
    await saveProject(dir, project)
  }

  it('lists newest first with project name and languages', async () => {
    await withSource('a.md')
    await withSource('b.md')
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

  it('is available when the source entry and its copy exist, even if output is missing', async () => {
    await withSource('a.md')
    rmSync(join(dir, 'output', 'a.md'))
    recordRecentDocument(settingsPath, { dir, file: 'a.md', output: 'a.md' }, 100)
    expect((await listRecentDocuments(settingsPath))[0].available).toBe(true)
  })

  it('is unavailable when the source copy is missing', async () => {
    await withSource('a.md')
    rmSync(join(dir, 'source', 'a.md'))
    recordRecentDocument(settingsPath, { dir, file: 'a.md', output: 'a.md' }, 100)
    expect((await listRecentDocuments(settingsPath))[0].available).toBe(false)
  })

  it('is unavailable when the source entry is no longer listed in the project', async () => {
    writeFileSync(join(dir, 'source', 'a.md'), 'x')
    recordRecentDocument(settingsPath, { dir, file: 'a.md', output: 'a.md' }, 100)
    expect((await listRecentDocuments(settingsPath))[0].available).toBe(false)
  })

  it('marks entries unavailable when the folder is gone', async () => {
    await withSource('a.md')
    recordRecentDocument(settingsPath, { dir, file: 'a.md', output: 'a.md' }, 100)
    let list = await listRecentDocuments(settingsPath)
    expect(list[0].available).toBe(true)
    rmSync(dir, { recursive: true, force: true })
    list = await listRecentDocuments(settingsPath)
    expect(list.every((r) => !r.available)).toBe(true)
    expect(list[0].projectName).toBe('Demo')
  })

  it('keeps the newest of duplicates in an unsorted stored list', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        translationProjects: [{ dir, lastOpened: 1 }],
        translationRecentDocuments: [
          { dir, file: 'a.md', output: 'a.md', openedAt: 10 },
          { dir, file: 'a.md', output: 'a.md', openedAt: 90 },
        ],
      }),
    )
    expect((await listRecentDocuments(settingsPath)).map((r) => r.openedAt)).toEqual([90])
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

describe('forgetRecentDocument', () => {
  it('drops only the matching project+file entry and keeps the rest', async () => {
    const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { forgetRecentDocument, RECENT_DOCUMENTS_KEY } = await import(
      '../src/main/translate/recent-documents'
    )
    const dir = mkdtempSync(join(tmpdir(), 'recent-forget-'))
    const settings = join(dir, 'settings.json')
    const entry = (file: string, at: number) => ({
      dir: join(dir, 'p'),
      file,
      output: `${file}.out`,
      openedAt: at,
    })
    writeFileSync(
      settings,
      JSON.stringify({ [RECENT_DOCUMENTS_KEY]: [entry('a.docx', 2), entry('b.docx', 1)] }),
    )
    forgetRecentDocument(settings, { dir: join(dir, 'p'), file: 'a.docx' })
    const left = JSON.parse(readFileSync(settings, 'utf8'))[RECENT_DOCUMENTS_KEY]
    expect(left.map((e: { file: string }) => e.file)).toEqual(['b.docx'])
  })
})
