import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readAppSettings, writeAppSettings } from '../src/main/app-settings'
import { createTranslateHandlers, registerTranslateIpc } from '../src/main/translate/translate-ipc'
import {
  InvalidProjectNameError,
  NotAProjectError,
  NotListedError,
  ProjectExistsError,
  ProjectFileError,
  UnsupportedSourceError,
} from '@genoffice/translate-project'
import {
  TRANSLATE_CHANNELS,
  parseTranslateError,
  toTranslateIpcError,
} from '../src/shared/translate-api'

let root: string
let settingsPath: string
let clock: number

function handlers() {
  return createTranslateHandlers({ settingsPath: () => settingsPath, now: () => clock })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'translate-ipc-'))
  settingsPath = join(root, 'app-settings.json')
  clock = 1000
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('translate IPC handlers', () => {
  it('create registers the folder and list reports it', async () => {
    const h = handlers()
    const { dir } = await h.create({
      parentDir: root,
      name: 'P1',
      sourceLang: 'en',
      targetLang: 'ko',
    })
    const list = await h.list()
    expect(list).toEqual([
      { dir, name: 'P1', status: 'ok', sourceLang: 'en', targetLang: 'ko', lastOpened: 1000 },
    ])
  })

  it('list marks a deleted folder as not-found without throwing', async () => {
    const h = handlers()
    const { dir } = await h.create({
      parentDir: root,
      name: 'Gone',
      sourceLang: 'en',
      targetLang: 'ko',
    })
    rmSync(dir, { recursive: true, force: true })
    const list = await h.list()
    expect(list).toHaveLength(1)
    expect(list[0]?.status).toBe('not-found')
  })

  it('list marks a corrupt project file as invalid', async () => {
    const h = handlers()
    const { dir } = await h.create({
      parentDir: root,
      name: 'Bad',
      sourceLang: 'en',
      targetLang: 'ko',
    })
    writeFileSync(join(dir, '.tandem', 'project.json'), '{not json')
    expect((await h.list())[0]?.status).toBe('invalid')
  })

  it('remove with deleteFolder false only drops the list entry', async () => {
    const h = handlers()
    const { dir } = await h.create({
      parentDir: root,
      name: 'Keep',
      sourceLang: 'en',
      targetLang: 'ko',
    })
    await h.remove({ dir, deleteFolder: false })
    expect(existsSync(dir)).toBe(true)
    expect(await h.list()).toEqual([])
  })

  it('remove with deleteFolder true deletes the folder and the entry', async () => {
    const h = handlers()
    const { dir } = await h.create({
      parentDir: root,
      name: 'Del',
      sourceLang: 'en',
      targetLang: 'ko',
    })
    await h.remove({ dir, deleteFolder: true })
    expect(existsSync(dir)).toBe(false)
    expect(await h.list()).toEqual([])
  })

  it('set/get system prompt roundtrips through settings', async () => {
    const h = handlers()
    expect(await h.getSystemPrompt()).toBe('')
    await h.setSystemPrompt('Be literal.')
    expect(await h.getSystemPrompt()).toBe('Be literal.')
    expect(readAppSettings(settingsPath).translationSystemPrompt).toBe('Be literal.')
  })

  it('ignores invalid stored settings and falls back to defaults', async () => {
    writeAppSettings(settingsPath, {
      translationSystemPrompt: 42,
      translationProjects: [
        { dir: 'relative', lastOpened: 1 },
        'x',
        { dir: root, lastOpened: 'no' },
      ],
    })
    const h = handlers()
    expect(await h.getSystemPrompt()).toBe('')
    expect((await h.list()).map((e) => e.dir)).toEqual([root])
  })

  it('add-material for glossary returns project with glossaryFiles updated', async () => {
    const h = handlers()
    const { dir } = await h.create({
      parentDir: root,
      name: 'G',
      sourceLang: 'en',
      targetLang: 'ko',
    })
    const csv = join(root, 'terms.csv')
    writeFileSync(csv, 'source,target\nhello,안녕\n')
    const project = await h.addMaterial({ dir, kind: 'glossary', path: csv })
    expect(project.glossaryFiles).toContain('terms.csv')
    expect((await h.getProject(dir)).glossaryFiles).toContain('terms.csv')
    const after = await h.removeMaterial({ dir, kind: 'glossary', file: 'terms.csv' })
    expect(after.glossaryFiles).not.toContain('terms.csv')
  })

  it('add-material rejects empty and missing paths', async () => {
    const h = handlers()
    const { dir } = await h.create({
      parentDir: root,
      name: 'M',
      sourceLang: 'en',
      targetLang: 'ko',
    })
    await expect(h.addMaterial({ dir, kind: 'source', path: '' })).rejects.toThrow()
    await expect(
      h.addMaterial({ dir, kind: 'source', path: join(root, 'nope.docx') }),
    ).rejects.toThrow()
    await expect(h.addMaterial({ dir, kind: 'bogus' as never, path: root })).rejects.toThrow()
  })

  it('rejects every dir that is not a registered project', async () => {
    const h = handlers()
    const { dir: other } = await handlers().create({
      parentDir: root,
      name: 'Other',
      sourceLang: 'en',
      targetLang: 'ko',
    })
    writeAppSettings(settingsPath, { translationProjects: [] })
    await expect(h.getProject(other)).rejects.toThrow(/not a registered/)
    await expect(h.saveProject(other, {} as never)).rejects.toThrow(/not a registered/)
    await expect(h.remove({ dir: other, deleteFolder: true })).rejects.toThrow(/not a registered/)
    expect(existsSync(other)).toBe(true)
    await expect(h.addMaterial({ dir: other, kind: 'source', path: root })).rejects.toThrow(
      /not a registered/,
    )
    await expect(h.removeMaterial({ dir: other, kind: 'source', file: 'a' })).rejects.toThrow(
      /not a registered/,
    )
    await expect(h.getProject('relative/dir')).rejects.toThrow(/not a registered/)
  })

  it('save-project persists a valid project and rejects an invalid one', async () => {
    const h = handlers()
    const { dir } = await h.create({
      parentDir: root,
      name: 'S',
      sourceLang: 'en',
      targetLang: 'ko',
    })
    const p = await h.getProject(dir)
    await h.saveProject(dir, { ...p, targetLang: 'ja' })
    expect((await h.getProject(dir)).targetLang).toBe('ja')
    await expect(h.saveProject(dir, { nope: true } as never)).rejects.toThrow()
  })

  it('get-project refreshes lastOpened in the settings entry only', async () => {
    const h = handlers()
    const { dir } = await h.create({
      parentDir: root,
      name: 'L',
      sourceLang: 'en',
      targetLang: 'ko',
    })
    clock = 5000
    await h.getProject(dir)
    expect((await h.list())[0]?.lastOpened).toBe(5000)
  })
})

describe('remove robustness', () => {
  const mk = (h: ReturnType<typeof handlers>, name: string) =>
    h.create({ parentDir: root, name, sourceLang: 'en', targetLang: 'ko' })

  it('deleteFolder true on a missing folder drops the entry without throwing', async () => {
    const h = handlers()
    const { dir } = await mk(h, 'Miss')
    rmSync(dir, { recursive: true, force: true })
    await expect(h.remove({ dir, deleteFolder: true })).resolves.toBeUndefined()
    expect(await h.list()).toEqual([])
  })

  it('deleteFolder true on a corrupt project drops the entry and keeps the folder', async () => {
    const h = handlers()
    const { dir } = await mk(h, 'Corrupt')
    writeFileSync(join(dir, '.tandem', 'project.json'), '{bad')
    await expect(h.remove({ dir, deleteFolder: true })).resolves.toBeUndefined()
    expect(existsSync(dir)).toBe(true)
    expect(await h.list()).toEqual([])
  })

  it('delete is serialized with a concurrent addReference', async () => {
    const h = handlers()
    const { dir } = await mk(h, 'Race')
    const ref = join(root, 'ref.txt')
    writeFileSync(ref, 'x')
    const add = h.addMaterial({ dir, kind: 'reference', path: ref })
    const del = h.remove({ dir, deleteFolder: true })
    const results = await Promise.allSettled([add, del])
    expect(results[1].status).toBe('fulfilled')
    expect(existsSync(dir)).toBe(false)
    expect(await h.list()).toEqual([])
  })
})

describe('get-project with an unwritable settings file', () => {
  it('still returns the project', async () => {
    const h = handlers()
    const { dir } = await h.create({
      parentDir: root,
      name: 'RO',
      sourceLang: 'en',
      targetLang: 'ko',
    })
    // a directory squatting on the temp-file parent makes the atomic write fail
    chmodSync(root, 0o500)
    try {
      expect((await h.getProject(dir)).name).toBe('RO')
    } finally {
      chmodSync(root, 0o700)
    }
  })
})

describe('error codes', () => {
  it('maps each translate-project error class to its code', () => {
    const cases: [unknown, string][] = [
      [new ProjectExistsError('/x'), 'PROJECT_EXISTS'],
      [new InvalidProjectNameError('?'), 'INVALID_PROJECT_NAME'],
      [new NotListedError('a'), 'NOT_LISTED'],
      [new NotAProjectError('/x'), 'NOT_A_PROJECT'],
      [new UnsupportedSourceError('a.zip'), 'UNSUPPORTED_SOURCE'],
      [new ProjectFileError('bad'), 'PROJECT_FILE_INVALID'],
      [new Error('boom'), 'UNKNOWN'],
      ['text', 'UNKNOWN'],
    ]
    for (const [err, code] of cases) {
      const mapped = toTranslateIpcError(err)
      expect(mapped.code).toBe(code)
      expect(mapped.message.startsWith(`[${code}] `)).toBe(true)
    }
  })

  it('parses an Electron-wrapped message', () => {
    const wrapped = new Error(
      "Error invoking remote method 'translate:create': Error: [PROJECT_EXISTS] project folder already exists: /a",
    )
    expect(parseTranslateError(wrapped)).toEqual({
      code: 'PROJECT_EXISTS',
      message: 'project folder already exists: /a',
    })
    expect(parseTranslateError(toTranslateIpcError(new NotListedError('f'))).code).toBe(
      'NOT_LISTED',
    )
    expect(parseTranslateError(new Error('plain')).code).toBe('UNKNOWN')
    expect(parseTranslateError(new Error('[NOPE] x')).code).toBe('UNKNOWN')
  })

  it('handlers throw coded errors', async () => {
    const h = handlers()
    await expect(h.getProject('/not/registered')).rejects.toMatchObject({ code: 'NOT_REGISTERED' })
    await expect(h.setSystemPrompt(5 as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await h.create({ parentDir: root, name: 'Dup', sourceLang: 'en', targetLang: 'ko' })
    await expect(
      h.create({ parentDir: root, name: 'Dup', sourceLang: 'en', targetLang: 'ko' }),
    ).rejects.toMatchObject({ code: 'PROJECT_EXISTS' })
  })
})

describe('registerTranslateIpc', () => {
  it('registers every channel once with the translate: prefix', () => {
    const seen: string[] = []
    registerTranslateIpc({ handle: (c: string) => void seen.push(c) } as never, {
      settingsPath: () => settingsPath,
      now: () => clock,
    })
    expect(seen.sort()).toEqual(Object.values(TRANSLATE_CHANNELS).sort())
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen.every((c) => c.startsWith('translate:'))).toBe(true)
  })
})
