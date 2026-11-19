import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readAppSettings, writeAppSettings } from '../src/main/app-settings'
import { createTranslateHandlers, registerTranslateIpc } from '../src/main/translate/translate-ipc'
import {
  GlossaryFormatError,
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

function handlers(extra: Partial<Parameters<typeof createTranslateHandlers>[0]> = {}) {
  return createTranslateHandlers({
    settingsPath: () => settingsPath,
    now: () => clock,
    showOpenDialog: async (options) => {
      dialogOptions.push(options)
      return dialogResult
    },
    ...extra,
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
      {
        dir,
        name: 'P1',
        status: 'ok',
        sourceLang: 'en',
        targetLang: 'ko',
        lastOpened: 1000,
        sourceCount: 0,
        referenceCount: 0,
      },
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

  it('makeFolder makes a folder inside a picked one and the new folder becomes the place', async () => {
    const h = handlers()
    dialogResult = { canceled: false, filePaths: [root] }
    const picked = await h.pickParentDir()
    const made = await h.makeFolder({ parentToken: picked!.token, name: 'Books' })
    expect(made.dir).toBe(join(root, 'Books'))
    expect(statSync(made.dir).isDirectory()).toBe(true)
    // a project can be created in the new place
    const { dir } = await h.create({
      parentToken: made.token,
      name: 'Demo',
      sourceLang: 'ko',
      targetLang: 'en',
    })
    expect(dir).toBe(join(root, 'Books', 'Demo'))
    // an existing folder, a bad name and an unpicked parent are refused
    await expect(h.makeFolder({ parentToken: picked!.token, name: 'Books' })).rejects.toMatchObject(
      {
        code: 'PROJECT_EXISTS',
      },
    )
    await expect(h.makeFolder({ parentToken: picked!.token, name: '..' })).rejects.toMatchObject({
      code: 'INVALID_PROJECT_NAME',
    })
    await expect(h.makeFolder({ parentToken: 'nope', name: 'X' })).rejects.toMatchObject({
      code: 'NOT_REGISTERED',
    })
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

  it('rename changes only the display name, keeps the folder and other projects', async () => {
    const h = handlers()
    const a = await createIn(h, { name: 'Alpha', sourceLang: 'en', targetLang: 'ko' })
    const b = await createIn(h, { name: 'Beta', sourceLang: 'en', targetLang: 'ko' })
    const beforeB = await h.getProject(b.dir)
    const renamed = await h.rename({ dir: a.dir, name: '  Gamma 한글  ' })
    expect(renamed.name).toBe('Gamma 한글')
    expect((await h.getProject(a.dir)).name).toBe('Gamma 한글')
    expect(await h.getProject(b.dir)).toEqual(beforeB)
    const listed = await h.list()
    expect(listed.find((e) => e.dir === a.dir)?.name).toBe('Gamma 한글')
    expect(listed.find((e) => e.dir === b.dir)?.name).toBe('Beta')
    // names need not be unique
    expect((await h.rename({ dir: a.dir, name: 'Beta' })).name).toBe('Beta')
  })

  it('rename rejects empty, too long, control characters and unregistered folders', async () => {
    const h = handlers()
    const { dir } = await createIn(h, { name: 'Alpha', sourceLang: 'en', targetLang: 'ko' })
    const bad = (name: unknown) =>
      expect(h.rename({ dir, name } as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await bad('')
    await bad('   ')
    await bad('x'.repeat(81))
    await bad('a\u0000b')
    await bad('a\nb')
    await bad(5)
    expect((await h.rename({ dir, name: 'x'.repeat(80) })).name).toHaveLength(80)
    await expect(h.rename({ dir: join(root, 'nope'), name: 'ok' })).rejects.toThrow(
      /not a registered/,
    )
  })

  it('update-settings saves a writing style and rejects unknown values', async () => {
    const h = handlers()
    const { dir } = await createIn(h, { name: 'S', sourceLang: 'en', targetLang: 'ko' })
    // a new project starts with the Oxford comma and punctuation inside the quotes
    expect((await h.getProject(dir)).writingStyle).toEqual({
      serialComma: 'with',
      quotePunctuation: 'inside',
      italics: 'apply',
      custom: '',
    })
    const style = {
      serialComma: 'without',
      quotePunctuation: 'outside',
      italics: 'off',
      custom: 'x',
    } as const
    const updated = await h.updateSettings({ dir, patch: { writingStyle: style } })
    expect(updated.writingStyle).toEqual(style)
    expect((await h.getProject(dir)).writingStyle).toEqual(style)
    const bad = (writingStyle: unknown) =>
      expect(h.updateSettings({ dir, patch: { writingStyle } } as never)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      })
    await bad({ ...style, serialComma: 'sometimes' })
    await bad({ ...style, quotePunctuation: 'both' })
    await bad({ ...style, italics: 'always' })
    await bad({ ...style, italics: true })
    await bad({ ...style, custom: 5 })
    await bad({ ...style, custom: 'x'.repeat(501) })
    await bad(null)
    await bad('with')
    expect((await h.getProject(dir)).writingStyle).toEqual(style)
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
  it('only opens the profile wiki from the main shell, without renderer-supplied paths', async () => {
    const answers = new Map<string, (event: { sender: unknown }, ...args: unknown[]) => unknown>()
    const wiki = {
      openWiki: vi.fn(async () => ({ status: 'opened' as const, vaultPath: '/profile/wiki' })),
      resumeWiki: vi.fn(async () => ({ status: 'idle' as const, vaultPath: '' })),
    }
    registerTranslateIpc(
      { handle: (c: string, fn: never) => void answers.set(c, fn) } as never,
      {
        settingsPath: () => settingsPath,
        now: () => clock,
        showOpenDialog: async () => dialogResult,
        wiki,
      },
      (sender) => sender === 'shell' || sender === 'ocr-overlay',
      (sender) => sender === 'shell',
    )
    for (const action of ['openWiki', 'resumeWiki'] as const) {
      const call = answers.get(TRANSLATE_CHANNELS[action])!
      await expect(call({ sender: 'ocr-overlay' })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      })
      await expect(call({ sender: 'shell' }, '/other-vault')).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      })
      expect(wiki[action]).not.toHaveBeenCalled()
      await call({ sender: 'shell' })
      expect(wiki[action]).toHaveBeenCalledExactlyOnceWith()
    }
  })

  it('registers every channel once with the translate: prefix', () => {
    const seen: string[] = []
    registerTranslateIpc(
      { handle: (c: string) => void seen.push(c) } as never,
      {
        settingsPath: () => settingsPath,
        now: () => clock,
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      },
      () => true,
    )
    expect(seen.sort()).toEqual(Object.values(TRANSLATE_CHANNELS).sort())
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen.every((c) => c.startsWith('translate:'))).toBe(true)
  })
})

describe('channels answer the shell window only', () => {
  function register(isShell: (sender: unknown) => boolean) {
    const answers = new Map<string, (event: { sender: unknown }, ...args: unknown[]) => unknown>()
    registerTranslateIpc(
      { handle: (c: string, fn: never) => void answers.set(c, fn) } as never,
      {
        settingsPath: () => settingsPath,
        now: () => clock,
        showOpenDialog: async () => dialogResult,
      },
      isShell,
    )
    return answers
  }
  const shell = { id: 1 }
  const editor = { id: 2 }

  it('refuses every channel (remove and the mutating ones included) from another window', async () => {
    const h = handlers()
    const { dir } = await createIn(h, { name: 'Guarded', sourceLang: 'en', targetLang: 'ko' })
    const answers = register((sender) => sender === shell)
    for (const [channel, answer] of answers) {
      const code = await Promise.resolve()
        .then(() => answer({ sender: editor }, { dir, deleteFolder: true }))
        .then(
          () => 'ok',
          (err: unknown) => parseTranslateError(err).code,
        )
      expect(code, channel).toBe('INVALID_ARGUMENT')
    }
    // nothing was removed or deleted
    expect(existsSync(dir)).toBe(true)
    expect((await h.list()).map((e) => e.dir)).toEqual([dir])
  })

  it('the recent-documents channel is registered and refuses other windows', async () => {
    const answers = register((sender) => sender === shell)
    const recent = answers.get(TRANSLATE_CHANNELS.recent)!
    expect(recent).toBeDefined()
    await expect(Promise.resolve().then(() => recent({ sender: editor }))).rejects.toMatchObject({
      message: expect.stringContaining('INVALID_ARGUMENT'),
    })
    expect(await recent({ sender: shell })).toEqual([])
  })

  it('answers the shell window', async () => {
    const answers = register((sender) => sender === shell)
    const listed = await answers.get(TRANSLATE_CHANNELS.list)!({ sender: shell })
    expect(listed).toEqual([])
  })
})

describe('create cleanup', () => {
  it('removes the folder it made when the settings cannot be written, so a retry works', async () => {
    const parent = join(root, 'parent')
    mkdirSync(parent)
    const h = handlers()
    // the settings file's folder is read-only: the atomic settings write fails
    chmodSync(root, 0o500)
    try {
      dialogResult = { canceled: false, filePaths: [parent] }
      const picked = await h.pickParentDir()
      await expect(
        h.create({ parentToken: picked!.token, name: 'Half', sourceLang: 'en', targetLang: 'ko' }),
      ).rejects.toBeDefined()
      expect(existsSync(join(parent, 'Half'))).toBe(false)
    } finally {
      chmodSync(root, 0o700)
    }
    const { dir } = await createIn(h, { name: 'Half', sourceLang: 'en', targetLang: 'ko' }, parent)
    expect(dir).toBe(join(parent, 'Half'))
  })
})

describe('delete folder while documents are open', () => {
  it('is refused with PROJECT_IN_USE and changes nothing', async () => {
    const asked: string[] = []
    const h = handlers({ isPathOpen: (dir) => (asked.push(dir), true) })
    const { dir } = await createIn(h, { name: 'Open', sourceLang: 'en', targetLang: 'ko' })
    await expect(h.remove({ dir, deleteFolder: true })).rejects.toMatchObject({
      code: 'PROJECT_IN_USE',
    })
    expect(asked).toEqual([dir])
    expect(existsSync(dir)).toBe(true)
    expect((await h.list()).map((e) => e.dir)).toEqual([dir])
  })

  it('removing from the list only stays allowed', async () => {
    const h = handlers({ isPathOpen: () => true })
    const { dir } = await createIn(h, { name: 'Open2', sourceLang: 'en', targetLang: 'ko' })
    await h.remove({ dir, deleteFolder: false })
    expect(existsSync(dir)).toBe(true)
    expect(await h.list()).toEqual([])
  })

  it('deletes once nothing under the folder is open', async () => {
    const h = handlers({ isPathOpen: () => false })
    const { dir } = await createIn(h, { name: 'Closed', sourceLang: 'en', targetLang: 'ko' })
    await h.remove({ dir, deleteFolder: true })
    expect(existsSync(dir)).toBe(false)
  })
})

describe('open an existing project folder', () => {
  function linkFake(result: 'listed' | 'refused') {
    const calls = { ensure: [] as string[], unlist: [] as string[] }
    return {
      calls,
      projects: {
        ensureListed: async (d: string) => {
          calls.ensure.push(d)
          return result === 'listed' ? ('p1' as never) : null
        },
        unlist: async (d: string) => void calls.unlist.push(d),
      },
    }
  }

  /** a project made by one app instance, then dropped from its list (as after a move) */
  async function madeElsewhere(name: string): Promise<string> {
    const h = handlers()
    const { dir } = await createIn(h, { name, sourceLang: 'en', targetLang: 'ko' })
    await h.remove({ dir, deleteFolder: false })
    return dir
  }

  it('registers a picked project folder and lists it through the project link', async () => {
    const dir = await madeElsewhere('Moved')
    const link = linkFake('listed')
    const h = handlers({ projects: link.projects })
    dialogResult = { canceled: false, filePaths: [dir] }
    expect(await h.pickExisting()).toEqual({ dir, name: 'Moved', contextLinked: true })
    expect(link.calls.ensure).toEqual([dir])
    expect((await h.list()).map((e) => e.dir)).toEqual([dir])
    expect(JSON.stringify(dialogOptions.at(-1))).toContain('openDirectory')
  })

  it('a folder the link refuses (foreign instructions) is registered but reported unlinked', async () => {
    const dir = await madeElsewhere('Foreign')
    const link = linkFake('refused')
    const h = handlers({ projects: link.projects })
    dialogResult = { canceled: false, filePaths: [dir] }
    expect(await h.pickExisting()).toEqual({ dir, name: 'Foreign', contextLinked: false })
    const stored = readAppSettings(settingsPath).translationProjects as { listed?: true }[]
    expect(stored[0]?.listed).toBeUndefined()
  })

  it('refuses a folder without a project file, and returns null when cancelled', async () => {
    const h = handlers()
    const plain = join(root, 'plain')
    mkdirSync(plain)
    dialogResult = { canceled: false, filePaths: [plain] }
    await expect(h.pickExisting()).rejects.toMatchObject({ code: 'NOT_A_PROJECT' })
    expect(await h.list()).toEqual([])
    dialogResult = { canceled: true, filePaths: [] }
    expect(await h.pickExisting()).toBeNull()
  })

  it('picking an already listed folder keeps one entry', async () => {
    const h = handlers()
    const { dir } = await createIn(h, { name: 'Twice', sourceLang: 'en', targetLang: 'ko' })
    dialogResult = { canceled: false, filePaths: [dir] }
    await h.pickExisting()
    expect((await h.list()).map((e) => e.dir)).toEqual([dir])
  })

  it('relocate replaces a not-found entry with the picked folder', async () => {
    const link = linkFake('listed')
    const h = handlers({ projects: link.projects })
    const { dir } = await createIn(h, { name: 'Away', sourceLang: 'en', targetLang: 'ko' })
    const moved = join(root, 'moved-here')
    renameSync(dir, moved)
    expect((await h.list())[0]?.status).toBe('not-found')
    dialogResult = { canceled: false, filePaths: [moved] }
    expect(await h.relocate({ dir })).toEqual({ dir: moved, name: 'Away', contextLinked: true })
    const list = await h.list()
    expect(list.map((e) => [e.dir, e.status])).toEqual([[moved, 'ok']])
    expect(link.calls.unlist).toContain(dir)
  })

  it('relocate only takes a registered entry and a real project folder', async () => {
    const h = handlers()
    await expect(h.relocate({ dir: join(root, 'nope') })).rejects.toMatchObject({
      code: 'NOT_REGISTERED',
    })
    const { dir } = await createIn(h, { name: 'Stay', sourceLang: 'en', targetLang: 'ko' })
    const plain = join(root, 'plain2')
    mkdirSync(plain)
    dialogResult = { canceled: false, filePaths: [plain] }
    await expect(h.relocate({ dir })).rejects.toMatchObject({ code: 'NOT_A_PROJECT' })
    expect((await h.list()).map((e) => e.dir)).toEqual([dir])
  })
})

describe('instructions summary', () => {
  it('reports what goes with each request without composing a request to send', async () => {
    const h = handlers()
    const { dir } = await createIn(h, { name: 'Ctx', sourceLang: 'en', targetLang: 'ko' })
    await h.setSystemPrompt('Be formal.')
    await h.updateSettings({ dir, patch: { projectPrompt: '' } })
    const ref = join(root, 'style.pdf')
    writeFileSync(ref, 'x')
    await addPicked(h, dir, 'reference', ref)
    const got = await h.instructionsFor({ dir, text: '' })
    expect(got.summary).toEqual({
      systemPrompt: true,
      projectPrompt: false,
      glossaryTotal: 0,
      glossaryLimit: 200,
      referenceNames: ['style.pdf'],
      referenceConverted: 0,
    })
  })
})

describe('glossary errors', () => {
  it('a glossary that cannot be read is GLOSSARY_INVALID', async () => {
    const h = handlers()
    const { dir } = await createIn(h, { name: 'Gl', sourceLang: 'en', targetLang: 'ko' })
    const bad = join(root, 'bad.xlsx')
    writeFileSync(bad, 'not a zip')
    await expect(addPicked(h, dir, 'glossary', bad)).rejects.toMatchObject({
      code: 'GLOSSARY_INVALID',
    })
    expect(toTranslateIpcError(new GlossaryFormatError('x')).code).toBe('GLOSSARY_INVALID')
  })
})

describe('translation view handlers', () => {
  function viewHandlers(view = fakeView()) {
    return {
      view,
      h: createTranslateHandlers({
        settingsPath: () => settingsPath,
        now: () => clock,
        showOpenDialog: async () => dialogResult,
        view,
      }),
    }
  }

  function fakeView() {
    const opened: string[] = []
    return {
      opened,
      openTab: (path: string) => {
        opened.push(path)
        return { tabId: `t${opened.length}`, created: true }
      },
      closeTab: () => {},
      setTabReadOnly: () => true,
      showSplit: () => {},
      setPaneHidden: (_side: 'left' | 'right', _hidden: boolean) => true,
    }
  }

  it('open-translation takes the source entry from the project file', async () => {
    const { h, view } = viewHandlers()
    const { dir } = await createIn(h, { name: 'V', sourceLang: 'en', targetLang: 'ko' })
    const original = join(root, 'doc.md')
    writeFileSync(original, '# hi')
    await addPicked(h, dir, 'source', original)
    const result = await h.openTranslation({ dir, file: 'doc.md' })
    expect(result).toEqual({ flow: 'edit', sourceTabId: 't1', outputTabId: 't2', hashStatus: 'ok' })
    expect(view.opened).toEqual([join(dir, 'source', 'doc.md'), join(dir, 'output', 'doc.md')])
    // the original itself is never opened
    expect(view.opened).not.toContain(original)
  })

  it('open-translation records the document in the recent list (settings file only)', async () => {
    const { h } = viewHandlers()
    const { dir } = await createIn(h, { name: 'R', sourceLang: 'en', targetLang: 'ko' })
    const original = join(root, 'doc.md')
    writeFileSync(original, '# hi')
    await addPicked(h, dir, 'source', original)
    expect(await h.recent()).toEqual([])
    clock = 5000
    await h.openTranslation({ dir, file: 'doc.md' })
    expect(await h.recent()).toEqual([
      {
        dir,
        projectName: 'R',
        file: 'doc.md',
        sourceLang: 'en',
        targetLang: 'ko',
        openedAt: 5000,
        available: true,
      },
    ])
    expect(JSON.stringify(readAppSettings(settingsPath))).toContain('translationRecentDocuments')
    expect(readFileSync(join(dir, '.tandem', 'project.json'), 'utf8')).not.toContain('recent')
  })

  it('open-translation rejects unregistered folders and files not in the project', async () => {
    const { h, view } = viewHandlers()
    await expect(h.openTranslation({ dir: root, file: 'x.md' })).rejects.toMatchObject({
      code: 'NOT_REGISTERED',
    })
    const { dir } = await createIn(h, { name: 'W', sourceLang: 'en', targetLang: 'ko' })
    await expect(h.openTranslation({ dir, file: 'x.md' })).rejects.toMatchObject({
      code: 'NOT_LISTED',
    })
    await expect(h.openTranslation({ dir, file: 5 } as never)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    expect(view.opened).toEqual([])
  })

  it('open-translation without a tab strip fails with OPEN_FAILED', async () => {
    const h = handlers()
    const { dir } = await createIn(h, { name: 'X', sourceLang: 'en', targetLang: 'ko' })
    const original = join(root, 'doc.md')
    writeFileSync(original, '# hi')
    await addPicked(h, dir, 'source', original)
    await expect(h.openTranslation({ dir, file: 'doc.md' })).rejects.toMatchObject({
      code: 'OPEN_FAILED',
    })
  })

  it('set-pane-hidden validates its arguments and needs a translation view', async () => {
    const view = { ...fakeView(), setPaneHidden: (_s: 'left' | 'right', _h: boolean) => false }
    const { h } = viewHandlers(view)
    await expect(h.setPaneHidden({ side: 'top', hidden: true } as never)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    await expect(h.setPaneHidden({ side: 'left', hidden: 'yes' } as never)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    await expect(h.setPaneHidden({ side: 'left', hidden: true })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    const ok = viewHandlers()
    await expect(ok.h.setPaneHidden({ side: 'right', hidden: true })).resolves.toBeUndefined()
  })
})

describe('reference conversion', () => {
  it('converts a reference on add and reports its status and read-only text', async () => {
    const h = handlers()
    const { dir } = await createIn(h, { name: 'Refs', sourceLang: 'en', targetLang: 'ko' })
    const ref = join(root, 'notes.md')
    writeFileSync(ref, '# Terms\n\nengine means 엔진')
    await addPicked(h, dir, 'reference', ref)
    expect(await h.referenceStatus(dir)).toEqual({ 'notes.md': 'converted' })
    expect(await h.referenceText({ dir, file: 'notes.md' })).toEqual({
      text: '# Terms\n\nengine means 엔진',
      truncated: false,
    })
    // the reference itself is untouched
    expect(readFileSync(join(dir, 'references', 'notes.md'), 'utf8')).toBe(
      '# Terms\n\nengine means 엔진',
    )
    const got = await h.instructionsFor({ dir, text: 'engine' })
    expect(got.references).toBe('[notes.md — Terms]\n# Terms\n\nengine means 엔진')
  })

  it('a failed conversion never fails the add, and is reported per file', async () => {
    const h = handlers({
      convertReference: async () => {
        throw new Error('parser crashed')
      },
    })
    const { dir } = await createIn(h, { name: 'Bad', sourceLang: 'en', targetLang: 'ko' })
    const ref = join(root, 'broken.docx')
    writeFileSync(ref, 'x')
    const project = await addPicked(h, dir, 'reference', ref)
    expect(project.references).toEqual(['broken.docx'])
    expect(await h.referenceStatus(dir)).toEqual({ 'broken.docx': 'failed' })
    await expect(h.referenceText({ dir, file: 'broken.docx' })).rejects.toMatchObject({
      code: 'NOT_LISTED',
    })
  })

  it('a scan needs OCR', async () => {
    const h = handlers()
    const { dir } = await createIn(h, { name: 'Scan', sourceLang: 'en', targetLang: 'ko' })
    const ref = join(root, 'page.png')
    writeFileSync(ref, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    await addPicked(h, dir, 'reference', ref)
    expect(await h.referenceStatus(dir)).toEqual({ 'page.png': 'needs-ocr' })
  })

  it('the status converts references the index does not know yet', async () => {
    const h = handlers({ convertReference: async () => ({ ok: true, md: 'late text' }) })
    const { dir } = await createIn(h, { name: 'Late', sourceLang: 'en', targetLang: 'ko' })
    writeFileSync(join(dir, 'references', 'old.txt'), 'old')
    const project = JSON.parse(readFileSync(join(dir, '.tandem', 'project.json'), 'utf8'))
    writeFileSync(
      join(dir, '.tandem', 'project.json'),
      JSON.stringify({ ...project, references: ['old.txt'] }),
    )
    expect(await h.referenceStatus(dir)).toEqual({ 'old.txt': 'converted' })
  })

  it('reads only a listed reference of a registered project', async () => {
    const h = handlers()
    const { dir } = await createIn(h, { name: 'Guard', sourceLang: 'en', targetLang: 'ko' })
    await expect(h.referenceText({ dir, file: '../project.json' })).rejects.toMatchObject({
      code: 'NOT_LISTED',
    })
    await expect(h.referenceStatus(join(root, 'elsewhere'))).rejects.toMatchObject({
      code: 'NOT_REGISTERED',
    })
  })
})

describe('reference links and the context summary', () => {
  it('never reads a reference that is a link out of the project', async () => {
    const h = handlers()
    const { dir } = await createIn(h, { name: 'Link', sourceLang: 'en', targetLang: 'ko' })
    const secret = join(root, 'secret.txt')
    writeFileSync(secret, 'outside secret words')
    symlinkSync(secret, join(dir, 'references', 'notes.txt'))
    const project = JSON.parse(readFileSync(join(dir, '.tandem', 'project.json'), 'utf8'))
    writeFileSync(
      join(dir, '.tandem', 'project.json'),
      JSON.stringify({ ...project, references: ['notes.txt'] }),
    )
    expect(await h.referenceStatus(dir)).toEqual({ 'notes.txt': 'outside' })
    await expect(h.referenceText({ dir, file: 'notes.txt' })).rejects.toMatchObject({
      code: 'NOT_LISTED',
    })
    const got = await h.instructionsFor({ dir, text: 'secret' })
    expect(got.references).toBe('')
    expect(got.summary.referenceConverted).toBe(0)
  })

  it('counts the converted references in the summary', async () => {
    const h = handlers()
    const { dir } = await createIn(h, { name: 'Count', sourceLang: 'en', targetLang: 'ko' })
    const ref = join(root, 'notes.md')
    writeFileSync(ref, '# Terms\n\nengine')
    await addPicked(h, dir, 'reference', ref)
    const got = await h.instructionsFor({ dir, text: '' })
    expect(got.summary.referenceConverted).toBe(1)
  })
})

describe('exportTranslation handler', () => {
  async function projectWithOutput() {
    let dirty = false
    let target: string | null = null
    const h = handlers({
      exportTranslation: {
        showSaveDialog: async () =>
          target === null ? { canceled: true } : { canceled: false, filePath: target },
        isDirty: async () => dirty,
        documentsDir: () => root,
      },
    })
    const { dir } = await createIn(h, { name: 'Exp', sourceLang: 'en', targetLang: 'ko' })
    const src = join(root, 'a.md')
    writeFileSync(src, '# hello')
    await addPicked(h, dir, 'source', src)
    writeFileSync(join(dir, 'output', 'a.md'), '# annyeong')
    return {
      h,
      dir,
      setTarget: (p: string | null) => (target = p),
      setDirty: (d: boolean) => (dirty = d),
    }
  }

  it('exports by project source and by the output tab path, copying the saved bytes', async () => {
    const { h, dir, setTarget } = await projectWithOutput()
    setTarget(join(root, 'one.md'))
    expect(await h.exportTranslation({ dir, file: 'a.md' })).toEqual({
      status: 'saved',
      path: join(root, 'one.md'),
    })
    setTarget(join(root, 'two.md'))
    expect(await h.exportTranslation({ outputPath: join(dir, 'output', 'a.md') })).toEqual({
      status: 'saved',
      path: join(root, 'two.md'),
    })
    expect(readFileSync(join(root, 'two.md'), 'utf8')).toBe('# annyeong')
  })

  it('reports cancel and unsaved states without writing', async () => {
    const { h, dir, setTarget, setDirty } = await projectWithOutput()
    expect(await h.exportTranslation({ dir, file: 'a.md' })).toEqual({ status: 'canceled' })
    setDirty(true)
    setTarget(join(root, 'x.md'))
    expect(await h.exportTranslation({ dir, file: 'a.md' })).toEqual({ status: 'unsaved' })
    expect(existsSync(join(root, 'x.md'))).toBe(false)
  })

  it('refuses a folder that is not a registered project, a path outside output/ and the source folder', async () => {
    const { h, dir, setTarget } = await projectWithOutput()
    await expect(h.exportTranslation({ dir: root, file: 'a.md' })).rejects.toMatchObject({
      code: 'NOT_REGISTERED',
    })
    await expect(
      h.exportTranslation({ outputPath: join(dir, 'source', 'a.md') }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(
      h.exportTranslation({ outputPath: join(root, 'output', 'a.md') }),
    ).rejects.toMatchObject({ code: 'NOT_REGISTERED' })
    setTarget(join(dir, 'source', 'copy.md'))
    await expect(h.exportTranslation({ dir, file: 'a.md' })).rejects.toMatchObject({
      code: 'EXPORT_REFUSED',
    })
  })
})
