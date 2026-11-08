import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createProject } from '@genoffice/translate-project'
import { writeTranslationProjects } from '../src/main/app-settings'
import { translationLanguagesOfFile } from '../src/main/translate/language-of-file'

let root: string
let settingsPath: string
let dir: string

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'translate-lang-'))
  settingsPath = join(root, 'app-settings.json')
  dir = (await createProject(root, 'Demo', 'ko', 'en')).dir
  writeTranslationProjects(settingsPath, [{ dir, lastOpened: 1 }])
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('translationLanguagesOfFile', () => {
  it('gives the language pair for a file in the project source or output folder', async () => {
    const pair = { sourceLang: 'ko', targetLang: 'en' }
    expect(await translationLanguagesOfFile(settingsPath, join(dir, 'output', 'a.docx'))).toEqual(
      pair,
    )
    expect(await translationLanguagesOfFile(settingsPath, join(dir, 'source', 'a.docx'))).toEqual(
      pair,
    )
  })

  it('gives null for a file outside the project folders or an unknown path', async () => {
    writeFileSync(join(root, 'loose.docx'), 'x')
    expect(await translationLanguagesOfFile(settingsPath, join(root, 'loose.docx'))).toBeNull()
    expect(
      await translationLanguagesOfFile(settingsPath, join(dir, 'references', 'r.pdf')),
    ).toBeNull()
    expect(await translationLanguagesOfFile(settingsPath, undefined)).toBeNull()
    expect(await translationLanguagesOfFile(settingsPath, 'relative/a.docx')).toBeNull()
  })

  it('gives null when the project is not registered', async () => {
    writeTranslationProjects(settingsPath, [])
    expect(await translationLanguagesOfFile(settingsPath, join(dir, 'output', 'a.docx'))).toBeNull()
  })
})
