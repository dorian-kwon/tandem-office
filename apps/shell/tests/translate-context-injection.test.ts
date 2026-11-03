import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addGlossary,
  addReference,
  composeContext,
  createProject,
  loadProject,
  saveProject,
  type GlossaryEntry,
} from '@genoffice/translate-project'
import { writeTranslationProjects, writeTranslationSystemPrompt } from '../src/main/app-settings'
import {
  buildTranslationInstructions,
  translationContextForFolder,
} from '../src/main/translate/context-injection'

let root: string
let settingsPath: string
let dir: string

beforeEach(async () => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'translate-context-')))
  settingsPath = join(root, 'app-settings.json')
  dir = (await createProject(root, 'Manual', 'en', 'ko')).dir
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

async function setPrompt(text: string): Promise<void> {
  const project = await loadProject(dir)
  await saveProject(dir, { ...project, projectPrompt: text })
}

async function addGlossaryRows(rows: string[][], name = 'terms.csv'): Promise<void> {
  const path = join(root, name)
  writeFileSync(path, rows.map((r) => r.join(',')).join('\n'))
  await addGlossary(dir, path)
}

function rows(count: number, prefix = 'term'): string[][] {
  return Array.from({ length: count }, (_, i) => [`${prefix}${i}`, `용어${i}`])
}

describe('buildTranslationInstructions', () => {
  it('instructions include system prompt then project prompt then glossary', async () => {
    writeTranslationSystemPrompt(settingsPath, 'GLOBAL RULES')
    await setPrompt('PROJECT RULES')
    await addGlossaryRows([
      ['source', 'target'],
      ['engine', '엔진'],
    ])
    const ref = join(root, 'style.pdf')
    writeFileSync(ref, 'x')
    await addReference(dir, ref)

    const built = await buildTranslationInstructions(dir, 'the engine starts', { settingsPath })
    const text = built.text
    const sys = text.indexOf('GLOBAL RULES')
    const proj = text.indexOf('PROJECT RULES')
    const lang = text.indexOf('번역: en → ko')
    const gloss = text.indexOf('engine → 엔진')
    const refs = text.indexOf('- style.pdf')
    expect(sys).toBeGreaterThanOrEqual(0)
    expect(sys).toBeLessThan(proj)
    expect(proj).toBeLessThan(lang)
    expect(lang).toBeLessThan(gloss)
    expect(gloss).toBeLessThan(refs)
    expect(built.items.map((i) => [i.kind, i.included])).toEqual([
      ['system', true],
      ['project', true],
      ['glossary', true],
      ['reference', true],
    ])
    expect(built.glossaryIncluded).toBe(1)
    expect(built.glossaryTotal).toBe(1)
    expect(built.cut).toBe(false)
  })

  it('is exactly composeContext for the same inputs when it fits', async () => {
    writeTranslationSystemPrompt(settingsPath, 'S')
    await setPrompt('P')
    await addGlossaryRows([['alpha', '알파', 'greek']])
    const project = await loadProject(dir)
    const glossary: GlossaryEntry[] = [{ source: 'alpha', target: '알파', note: 'greek' }]
    const built = await buildTranslationInstructions(dir, 'alpha', { settingsPath })
    const expected = composeContext({ systemPrompt: 'S', project, glossary, paragraph: 'alpha' })
    expect(built.text).toBe(expected.text)
    expect(built.items).toEqual(expected.items)
  })

  it('selects glossary entries by the request text when the glossary is large', async () => {
    await addGlossaryRows(rows(300))
    // term250 is past the first 200 entries: only per-request matching can find it
    const built = await buildTranslationInstructions(dir, 'see term250 here', { settingsPath })
    expect(built.text).toContain('term250 → 용어250')
    expect(built.text).not.toContain('term0 →')
    // selectGlossary matches substrings: term2, term25 and term250
    expect(built.glossaryIncluded).toBe(3)
    expect(built.glossaryTotal).toBe(300)
    expect(built.glossarySelection).toBe('matching')
  })

  it('falls back to the first entries when nothing in the request matches', async () => {
    await addGlossaryRows(rows(300))
    const built = await buildTranslationInstructions(dir, 'translate this paragraph', {
      settingsPath,
    })
    expect(built.glossaryIncluded).toBe(200)
    expect(built.glossarySelection).toBe('first')
    expect(built.text).toContain('term0 → 용어0')
    expect(built.text).not.toContain('term200 →')
  })

  it('without request text takes the whole glossary when it is small', async () => {
    await addGlossaryRows(rows(50))
    const built = await buildTranslationInstructions(dir, '', { settingsPath })
    expect(built.glossaryIncluded).toBe(50)
    expect(built.glossarySelection).toBe('all')
    expect(built.text).toContain('term49 → 용어49')
  })

  it('without request text takes the first entries of a large glossary', async () => {
    await addGlossaryRows(rows(300))
    const built = await buildTranslationInstructions(dir, '', { settingsPath })
    expect(built.glossaryIncluded).toBe(200)
    expect(built.glossaryTotal).toBe(300)
    expect(built.glossarySelection).toBe('first')
    expect(built.text).toContain('term0 → 용어0')
    expect(built.text).toContain('term199 → 용어199')
    expect(built.text).not.toContain('term200 →')
  })

  it('splits the text into the prompts and the material', async () => {
    writeTranslationSystemPrompt(settingsPath, 'GLOBAL')
    await setPrompt('PROJECT')
    await addGlossaryRows([['engine', '엔진']])
    const ref = join(root, 'style.pdf')
    writeFileSync(ref, 'x')
    await addReference(dir, ref)
    const built = await buildTranslationInstructions(dir, '', { settingsPath })
    expect(built.promptText).toBe('GLOBAL\n\nPROJECT\n번역: en → ko')
    expect(built.materialText).toBe('단어집:\nengine → 엔진\n\n참고자료:\n- style.pdf')
    expect(`${built.promptText}\n\n${built.materialText}`).toBe(built.text)
  })

  it('drops whole glossary entries from the end when the text is over the limit', async () => {
    await addGlossaryRows(rows(100))
    const full = await buildTranslationInstructions(dir, '', { settingsPath })
    const limitChars = Math.floor(full.text.length / 2)
    const built = await buildTranslationInstructions(dir, '', { settingsPath, limitChars })
    expect(built.text.length).toBeLessThanOrEqual(limitChars)
    expect(built.glossaryIncluded).toBeGreaterThan(0)
    expect(built.glossaryIncluded).toBeLessThan(100)
    expect(built.glossaryTotal).toBe(100)
    expect(built.cut).toBe(false)
    // every included line is whole
    const last = built.glossaryIncluded - 1
    expect(built.text).toContain(`term${last} → 용어${last}`)
    expect(built.text).not.toContain(`term${last + 1} →`)
    expect(built.items[2]!.label).toBe(`단어집 (${built.glossaryIncluded}개)`)
  })

  it('cuts the prompts themselves at the limit and says so', async () => {
    writeTranslationSystemPrompt(settingsPath, 'x'.repeat(500))
    await addGlossaryRows(rows(5))
    const built = await buildTranslationInstructions(dir, '', { settingsPath, limitChars: 100 })
    expect(built.text.length).toBe(100)
    expect(built.glossaryIncluded).toBe(0)
    expect(built.cut).toBe(true)
  })
})

describe('translationContextForFolder', () => {
  it('no instructions are injected for a non-translation project folder', async () => {
    const plain = join(root, 'plain')
    mkdirSync(plain)
    expect(await translationContextForFolder(plain, { settingsPath })).toBeNull()
    // a translation project folder that is not registered is not one either
    expect(await translationContextForFolder(dir, { settingsPath })).toBeNull()
  })

  it('returns the text and the notice items for a registered translation project', async () => {
    writeTranslationProjects(settingsPath, [{ dir, lastOpened: 1 }])
    writeTranslationSystemPrompt(settingsPath, 'GLOBAL')
    await addGlossaryRows(rows(3))
    const context = await translationContextForFolder(dir, { settingsPath })
    expect(context?.prompts).toContain('GLOBAL')
    expect(context?.material).toContain('term2 → 용어2')
    expect(context?.items).toEqual([
      { kind: 'system', included: true },
      { kind: 'project', included: true },
      { kind: 'glossary', included: true, count: 3, total: 3 },
      { kind: 'reference', included: false, count: 0 },
    ])
    expect(context?.cut).toBe(false)
  })

  it('tells the AI how to translate a Word document without losing its formatting', async () => {
    writeTranslationProjects(settingsPath, [{ dir, lastOpened: 1 }])
    writeTranslationSystemPrompt(settingsPath, 'GLOBAL')
    const context = await translationContextForFolder(dir, { settingsPath })
    const prompts = context?.prompts ?? ''
    // the person's prompts come first, the editing rules after them
    expect(prompts.indexOf('GLOBAL')).toBeLessThan(prompts.indexOf('read_runs'))
    expect(prompts).toMatch(/read_runs[^\n]*then[^\n]*translate_blocks/)
    expect(prompts).toMatch(/never[^\n]*replace_blocks/i)
    expect(prompts).toMatch(/empty paragraphs/i)
    expect(prompts).toMatch(/footnote reference/i)
    expect(prompts).toMatch(/edit_note/)
  })

  it('keeps the whole text within the limit with the editing rules added', async () => {
    writeTranslationProjects(settingsPath, [{ dir, lastOpened: 1 }])
    writeTranslationSystemPrompt(settingsPath, 'x'.repeat(5000))
    const context = await translationContextForFolder(dir, { settingsPath, limitChars: 2000 })
    expect((context?.prompts.length ?? 0) + (context?.material.length ?? 0)).toBeLessThanOrEqual(
      2000,
    )
    expect(context?.prompts).toContain('translate_blocks')
    expect(context?.cut).toBe(true)
  })

  it('uses the request text it is given to pick entries of a large glossary', async () => {
    writeTranslationProjects(settingsPath, [{ dir, lastOpened: 1 }])
    await addGlossaryRows(rows(300))
    const context = await translationContextForFolder(dir, { settingsPath }, 'about term250')
    expect(context?.material).toContain('term250 → 용어250')
    expect(context?.items[2]).toEqual({
      kind: 'glossary',
      included: true,
      count: 3,
      total: 300,
      selection: 'matching',
    })
  })

  it('matches the folder through another spelling of its path', async () => {
    const link = join(root, 'link')
    symlinkSync(dir, link)
    writeTranslationProjects(settingsPath, [{ dir: link, lastOpened: 1 }])
    expect(await translationContextForFolder(dir, { settingsPath })).not.toBeNull()
  })

  it('gives nothing for a registered folder whose project file is broken', async () => {
    writeTranslationProjects(settingsPath, [{ dir, lastOpened: 1 }])
    writeFileSync(join(dir, '.tandem', 'project.json'), '{broken')
    expect(await translationContextForFolder(dir, { settingsPath })).toBeNull()
  })
})
