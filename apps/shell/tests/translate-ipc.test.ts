import { chmodSync, existsSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

let dialogResult: { canceled: boolean; filePaths: string[] }
let dialogOptions: unknown[]

function handlers() {
  return createTranslateHandlers({
    settingsPath: () => settingsPath,
    now: () => clock,
    showOpenDialog: async (options) => {
      dialogOptions.push(options)
      return dialogResult
    },
  })
}

type Handlers = ReturnType<typeof handlers>

/** Pick a parent folder through the (fake) dialog, then create the project in it. */
async function createIn(
  h: Handlers,
  args: { name: string; sourceLang: string; targetLang: string },
  parent = root,
) {
  dialogResult = { canceled: false, filePaths: [parent] }
  const picked = await h.pickParentDir()
  return h.create({ ...args, parentToken: picked!.token })
}

/** Pick one file through the (fake) dialog and add it to the project. */
async function addPicked(
  h: Handlers,
  dir: string,
  kind: 'source' | 'reference' | 'glossary',
  path: string,
) {
  dialogResult = { canceled: false, filePaths: [path] }
  const picked = await h.pickMaterials(kind)
  return h.addMaterial({ dir, kind, token: picked!.token, index: 0 })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'translate-ipc-'))
  settingsPath = join(root, 'app-settings.json')
  clock = 1000
  dialogOptions = []
  dialogResult = { canceled: true, filePaths: [] }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('translate IPC handlers', () => {
  it('create registers the folder and list reports it', async () => {
    const h = handlers()
    const { dir } = await createIn(h, {
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
    const { dir } = await createIn(h, {
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
    const { dir } = await createIn(h, {
      name: 'Bad',
      sourceLang: 'en',
      targetLang: 'ko',
    })
    writeFileSync(join(dir, '.tandem', 'project.json'), '{not json')
    expect((await h.list())[0]?.status).toBe('invalid')
  })

  it('remove with deleteFolder false only drops the list entry', async () => {
    const h = handlers()
    const { dir } = await createIn(h, {
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
    const { dir } = await createIn(h, {
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
    const { dir } = await createIn(h, {
      name: 'G',
      sourceLang: 'en',
      targetLang: 'ko',
    })
    const csv = join(root, 'terms.csv')
    writeFileSync(csv, 'source,target\nhello,안녕\n')
    const project = await addPicked(h, dir, 'glossary', csv)
    expect(project.glossaryFiles).toContain('terms.csv')
    expect((await h.getProject(dir)).glossaryFiles).toContain('terms.csv')
    const after = await h.removeMaterial({ dir, kind: 'glossary', file: 'terms.csv' })
    expect(after.glossaryFiles).not.toContain('terms.csv')
  })

  it('add-material rejects anything that was not picked', async () => {
    const h = handlers()
    const { dir } = await createIn(h, { name: 'M', sourceLang: 'en', targetLang: 'ko' })
    const stranger = join(root, 'stranger.txt')
    writeFileSync(stranger, 'x')
    const bad = (args: object) =>
      expect(h.addMaterial({ dir, ...args } as never)).rejects.toMatchObject({
        code: expect.stringMatching(/NOT_REGISTERED|INVALID_ARGUMENT/),
      })
    await bad({ kind: 'source', token: '', index: 0 })
    await bad({ kind: 'source', token: 'made-up', index: 0 })
    await bad({ kind: 'source', path: stranger })
    await bad({ kind: 'bogus', token: 'x', index: 0 })
    expect(readdirSync(join(dir, 'source'))).toEqual([])
  })

  it('a pick token is bound to its kind, index, one use, and expires', async () => {
    const h = handlers()
    const { dir } = await createIn(h, { name: 'T', sourceLang: 'en', targetLang: 'ko' })
    const a = join(root, 'a.txt')
    const b = join(root, 'b.txt')
    writeFileSync(a, 'a')
    writeFileSync(b, 'b')
    dialogResult = { canceled: false, filePaths: [a, b] }
    const picked = (await h.pickMaterials('reference'))!
    expect(picked.names).toEqual(['a.txt', 'b.txt'])
    expect(JSON.stringify(picked)).not.toContain(root)
    await expect(
      h.addMaterial({ dir, kind: 'source', token: picked.token, index: 0 }),
    ).rejects.toMatchObject({ code: 'NOT_REGISTERED' })
    await expect(
      h.addMaterial({ dir, kind: 'reference', token: picked.token, index: 5 }),
    ).rejects.toMatchObject({ code: 'NOT_REGISTERED' })
    const first = await h.addMaterial({ dir, kind: 'reference', token: picked.token, index: 0 })
    expect(first.references).toEqual(['a.txt'])
    await expect(
      h.addMaterial({ dir, kind: 'reference', token: picked.token, index: 0 }),
    ).rejects.toMatchObject({ code: 'NOT_REGISTERED' })
    clock += 6 * 60 * 1000
    await expect(
      h.addMaterial({ dir, kind: 'reference', token: picked.token, index: 1 }),
    ).rejects.toMatchObject({ code: 'NOT_REGISTERED' })
  })

  it('pick dialogs return null when cancelled and filter by kind', async () => {
    const h = handlers()
    expect(await h.pickMaterials('glossary')).toBeNull()
    expect(await h.pickParentDir()).toBeNull()
    expect(JSON.stringify(dialogOptions[0])).toContain('csv')
    expect(JSON.stringify(dialogOptions[1])).toContain('openDirectory')
  })

  it('create only accepts a picked parent folder', async () => {
    const h = handlers()
    await expect(
      h.create({ parentToken: 'nope', name: 'X', sourceLang: 'en', targetLang: 'ko' }),
    ).rejects.toMatchObject({ code: 'NOT_REGISTERED' })
    await expect(
      h.create({ parentDir: root, name: 'X', sourceLang: 'en', targetLang: 'ko' } as never),
    ).rejects.toMatchObject({ code: expect.stringMatching(/NOT_REGISTERED|INVALID_ARGUMENT/) })
    expect(existsSync(join(root, 'X'))).toBe(false)
  })

  it('rejects every dir that is not a registered project', async () => {
    const h = handlers()
    const { dir: other } = await createIn(handlers(), {
      name: 'Other',
      sourceLang: 'en',
      targetLang: 'ko',
    })
    writeAppSettings(settingsPath, { translationProjects: [] })
    await expect(h.getProject(other)).rejects.toThrow(/not a registered/)
    await expect(h.updateSettings({ dir: other, patch: {} })).rejects.toThrow(/not a registered/)
    await expect(h.remove({ dir: other, deleteFolder: true })).rejects.toThrow(/not a registered/)
    expect(existsSync(other)).toBe(true)
    await expect(
      h.addMaterial({ dir: other, kind: 'source', token: 't', index: 0 }),
    ).rejects.toThrow(/not a registered/)
    await expect(h.removeMaterial({ dir: other, kind: 'source', file: 'a' })).rejects.toThrow(
      /not a registered/,
    )
    await expect(h.getProject('relative/dir')).rejects.toThrow(/not a registered/)
  })

  it('update-settings changes only the four settings fields and returns the project', async () => {
    const h = handlers()
    const { dir } = await createIn(h, { name: 'S', sourceLang: 'en', targetLang: 'ko' })
    const updated = await h.updateSettings({
      dir,
      patch: {
        targetLang: 'ja',
        sourceLang: 'fr',
        projectPrompt: 'formal',
        ocr: { kind: 'off' },
      },
    })
    expect(updated).toMatchObject({
      targetLang: 'ja',
      sourceLang: 'fr',
      projectPrompt: 'formal',
      ocr: { kind: 'off' },
      name: 'S',
    })
    expect(await h.getProject(dir)).toEqual(updated)
  })

  it('update-settings rejects an invalid ocr, bad values and unknown keys', async () => {
    const h = handlers()
    const { dir } = await createIn(h, { name: 'S', sourceLang: 'en', targetLang: 'ko' })
    const before = await h.getProject(dir)
    const bad = (patch: object) =>
      expect(h.updateSettings({ dir, patch } as never)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      })
    await bad({ ocr: { kind: 'ai', provider: 'bogus' } })
    await bad({ ocr: 'off' })
    await bad({ projectPrompt: 5 })
    await bad({ targetLang: '' })
    await bad({ sources: [{ file: 'x.docx', sha256: 'x', kind: 'editable' }] })
    await bad({ name: 'Renamed', projectPrompt: 'ok' })
    expect(await h.getProject(dir)).toEqual(before)
  })

  it.each(['settings-first', 'material-first'])(
    'update-settings keeps lists written by a concurrent addMaterial (%s)',
    async (order) => {
      const h = handlers()
      const { dir } = await createIn(h, { name: 'S', sourceLang: 'en', targetLang: 'ko' })
      const ref = join(root, 'ref.txt')
      writeFileSync(ref, 'x')
      dialogResult = { canceled: false, filePaths: [ref] }
      const picked = (await h.pickMaterials('reference'))!
      const add = () => h.addMaterial({ dir, kind: 'reference', token: picked.token, index: 0 })
      const set = () => h.updateSettings({ dir, patch: { projectPrompt: 'p' } })
      await Promise.all(order === 'settings-first' ? [set(), add()] : [add(), set()])
      const final = await h.getProject(dir)
      expect(final.references).toEqual(['ref.txt'])
      expect(final.projectPrompt).toBe('p')
      expect(existsSync(join(dir, 'references', 'ref.txt'))).toBe(true)
    },
  )

  it('get-project refreshes lastOpened in the settings entry only', async () => {
    const h = handlers()
    const { dir } = await createIn(h, {
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
    createIn(h, { name, sourceLang: 'en', targetLang: 'ko' })

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
    const add = addPicked(h, dir, 'reference', ref)
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
    const { dir } = await createIn(h, {
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
    await createIn(h, { name: 'Dup', sourceLang: 'en', targetLang: 'ko' })
    await expect(
      createIn(h, { name: 'Dup', sourceLang: 'en', targetLang: 'ko' }),
    ).rejects.toMatchObject({ code: 'PROJECT_EXISTS' })
  })
})

describe('registerTranslateIpc', () => {
  it('registers every channel once with the translate: prefix', () => {
    const seen: string[] = []
    registerTranslateIpc({ handle: (c: string) => void seen.push(c) } as never, {
      settingsPath: () => settingsPath,
      now: () => clock,
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    })
    expect(seen.sort()).toEqual(Object.values(TRANSLATE_CHANNELS).sort())
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen.every((c) => c.startsWith('translate:'))).toBe(true)
  })
})
