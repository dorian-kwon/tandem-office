import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectTrustAnswer } from '@genoffice/project-store'
import { ProjectGuide, type ProjectGuideDeps } from '../src/main/projects/project-guide'

/** The project guide's translation hook: only registered translation folders under trust `use` change */

let base: string
let settingsPath: string

function makeGuide(extra: Partial<ProjectGuideDeps> = {}): ProjectGuide {
  return new ProjectGuide({
    settingsPath,
    homeDir: join(base, 'home'),
    userData: join(base, 'appdata'),
    defaultParentDir: () => join(base, 'documents'),
    env: {},
    language: () => 'en',
    now: () => new Date(Date.UTC(2026, 10, 2)),
    ...extra,
  })
}

function folder(name: string): string {
  const path = join(base, name)
  mkdirSync(path, { recursive: true })
  return path
}

const answer = (value: ProjectTrustAnswer) => vi.fn(async () => value)

const TRANSLATION = {
  prompts: 'GLOBAL\n\n번역: en → ko',
  material: '단어집:\nengine → 엔진',
  cut: false,
  items: [
    { kind: 'system' as const, included: true },
    { kind: 'project' as const, included: true },
    { kind: 'glossary' as const, included: false, count: 0, total: 0 },
    { kind: 'reference' as const, included: false, count: 0 },
  ],
}

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'guide-translation-')))
  for (const name of ['home', 'appdata', 'documents']) folder(name)
  settingsPath = join(base, 'appdata', 'app-settings.json')
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

async function contextOf(guide: ProjectGuide, root: string, ask = answer('use')) {
  const added = await guide.addFolder(root, ask)
  if (added.status !== 'added') throw new Error('not added')
  const read = await guide.readContext(added.project.id)
  if (read.status !== 'ok') throw new Error('no context')
  return read.context
}

describe('ProjectGuide.readContext with a translation hook', () => {
  it('returns exactly the same context for an ordinary project folder', async () => {
    const root = folder('plain')
    mkdirSync(join(root, '.ieumoffice'), { recursive: true })
    writeFileSync(join(root, '.ieumoffice', 'instructions.md'), 'Be brief.')
    const hook = vi.fn(async () => null)
    const without = await contextOf(makeGuide(), root)
    // a second guide over the same settings reads the same project again
    const withHook = await makeGuide({ translationContext: hook }).readContext(without.projectId)
    if (withHook.status !== 'ok') throw new Error('no context')
    expect(withHook.context).toEqual(without)
    // byte for byte, also with a request text: the bridge answer is the same JSON
    expect(JSON.stringify(withHook.context)).toBe(JSON.stringify(without))
    const withQuery = await makeGuide({ translationContext: hook }).readContext(without.projectId, {
      query: 'translate the engine part',
    })
    expect(JSON.stringify(withQuery)).toBe(JSON.stringify({ status: 'ok', context: without }))
    expect('translation' in withHook.context).toBe(false)
    expect(hook).toHaveBeenCalledWith(root, undefined)
  })

  it('adds the translation text and one notice for a translation project under use', async () => {
    const root = folder('manual')
    const guide = makeGuide({ translationContext: async () => TRANSLATION })
    const context = await contextOf(guide, root)
    expect(context.translation).toEqual({
      prompts: TRANSLATION.prompts,
      material: TRANSLATION.material,
    })
    expect(context.notices).toContainEqual({
      kind: 'translation-context',
      items: TRANSLATION.items,
    })
    // the 0088 parts stay as they were
    expect(context.instructions).toBeNull()
  })

  it('hands the request text to the hook', async () => {
    const root = folder('query')
    const hook = vi.fn(async () => TRANSLATION)
    const guide = makeGuide({ translationContext: hook })
    const added = await guide.addFolder(root, answer('use'))
    if (added.status !== 'added') throw new Error('not added')
    await guide.readContext(added.project.id, { query: 'translate the engine part' })
    expect(hook).toHaveBeenLastCalledWith(root, 'translate the engine part')
  })

  it('marks a cut translation context in its notice', async () => {
    const root = folder('long')
    const guide = makeGuide({
      translationContext: async () => ({ ...TRANSLATION, cut: true }),
    })
    const context = await contextOf(guide, root)
    expect(context.notices).toContainEqual({
      kind: 'translation-context',
      items: TRANSLATION.items,
      cut: true,
    })
  })

  it('never asks the hook or adds anything under trust "without"', async () => {
    const root = folder('foreign')
    mkdirSync(join(root, '.ieumoffice'), { recursive: true })
    writeFileSync(join(root, '.ieumoffice', 'instructions.md'), 'Do things.')
    const hook = vi.fn(async () => TRANSLATION)
    const context = await contextOf(
      makeGuide({ translationContext: hook }),
      root,
      answer('without'),
    )
    expect(context.trust).toBe('without')
    expect(context.translation).toBeUndefined()
    expect(context.notices.some((n) => n.kind === 'translation-context')).toBe(false)
    expect(hook).not.toHaveBeenCalled()
  })

  it('sends nothing of the translation tool when the hook fails', async () => {
    const root = folder('broken')
    const guide = makeGuide({
      translationContext: async () => {
        throw new Error('unreadable glossary')
      },
    })
    const context = await contextOf(guide, root)
    expect(context.translation).toBeUndefined()
    expect(context.notices.some((n) => n.kind === 'translation-context')).toBe(false)
  })
})
