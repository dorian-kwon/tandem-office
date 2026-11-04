import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createProject,
  loadProject,
  TRANSLATION_CHOICE_KEYS,
} from '@genoffice/translate-project'
import { writeTranslationProjects } from '../src/main/app-settings'
import { rememberTranslationChoice } from '../src/main/translate/choices'
import { buildTranslationInstructions } from '../src/main/translate/context-injection'
import { createTranslateHandlers } from '../src/main/translate/translate-ipc'

let work: string
let settingsPath: string
let dir: string

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'choices-'))
  settingsPath = join(work, 'app-settings.json')
  dir = (await createProject(work, 'p', 'ko', 'en')).dir
  writeTranslationProjects(settingsPath, [{ dir, lastOpened: 1 }])
})
afterEach(() => rm(work, { recursive: true, force: true }))

describe('rememberTranslationChoice (an editor panel keeps an answer for the project)', () => {
  it('writes the answer into the registered project file', async () => {
    const r = await rememberTranslationChoice(settingsPath, dir, 'outputMode', 'Overwrite')
    expect(r).toEqual({ ok: true })
    expect((await loadProject(dir)).choices).toEqual({ outputMode: 'Overwrite' })
    await rememberTranslationChoice(settingsPath, dir, 'bilingual', 'Two columns')
    expect((await loadProject(dir)).choices).toEqual({
      outputMode: 'Overwrite',
      bilingual: 'Two columns',
    })
  })

  it('refuses a folder that is not a registered translation project', async () => {
    const other = join(work, 'elsewhere')
    expect(await rememberTranslationChoice(settingsPath, other, 'outputMode', 'x')).toEqual({
      ok: false,
      reason: 'not-translation',
    })
  })

  it('refuses an unknown key and a blank value without touching the file', async () => {
    expect(await rememberTranslationChoice(settingsPath, dir, 'projectPrompt', 'x')).toEqual({
      ok: false,
      reason: 'invalid',
    })
    expect(await rememberTranslationChoice(settingsPath, dir, 'outputMode', '   ')).toEqual({
      ok: false,
      reason: 'invalid',
    })
    expect((await loadProject(dir)).choices).toBeUndefined()
  })
})

describe('updateSettings carries choices (the detail screen resets one)', () => {
  const handlers = () =>
    createTranslateHandlers({
      settingsPath: () => settingsPath,
      now: () => 1,
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    })

  it('replaces the stored answers, so a reset clears one item', async () => {
    await rememberTranslationChoice(settingsPath, dir, 'outputMode', 'Overwrite')
    await rememberTranslationChoice(settingsPath, dir, 'bilingual', 'Two columns')
    const saved = await handlers().updateSettings({
      dir,
      patch: { choices: { bilingual: 'Two columns' } },
    })
    expect(saved.choices).toEqual({ bilingual: 'Two columns' })
    const cleared = await handlers().updateSettings({ dir, patch: { choices: {} } })
    expect(cleared.choices).toBeUndefined()
    expect((await loadProject(dir)).choices).toBeUndefined()
  })

  it('rejects a choices value that is not an object', async () => {
    await expect(handlers().updateSettings({ dir, patch: { choices: 'x' } as never })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
  })
})

describe('the panel and the project agree on the keepable answers', () => {
  it('lists the same keys in the ui package and the project file', () => {
    const src = readFileSync(
      new URL('../../../packages/ui/src/project-choice.ts', import.meta.url),
      'utf8',
    )
    const listed = /CHOICE_REMEMBER_KEYS: readonly string\[\] = \[([^\]]*)\]/.exec(src)?.[1]
    const keys = [...(listed ?? '').matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1])
    expect(keys).toEqual([...TRANSLATION_CHOICE_KEYS])
  })
})

describe('the kept answers reach the AI request', () => {
  it('state them as rules, ask only for what is missing, and ask again after a reset', async () => {
    const ask = (text: string, name: string) => text.includes(`${name} is not decided`)
    let built = await buildTranslationInstructions(dir, '', { settingsPath })
    expect(ask(built.promptText, 'Output mode')).toBe(true)
    await rememberTranslationChoice(settingsPath, dir, 'outputMode', 'Overwrite')
    built = await buildTranslationInstructions(dir, '', { settingsPath })
    expect(built.promptText).toContain('- Output mode: Overwrite')
    expect(ask(built.promptText, 'Output mode')).toBe(false)
    expect(ask(built.promptText, 'Bilingual layout')).toBe(true)
    await createTranslateHandlers({
      settingsPath: () => settingsPath,
      now: () => 1,
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    }).updateSettings({ dir, patch: { choices: {} } })
    built = await buildTranslationInstructions(dir, '', { settingsPath })
    expect(ask(built.promptText, 'Output mode')).toBe(true)
  })
})
