import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addGlossary, createProject, loadProject, saveProject } from '@genoffice/translate-project'
import { writeTranslationProjects, writeTranslationSystemPrompt } from '../src/main/app-settings'
import {
  buildTranslationInstructions,
  TRANSLATION_EDITING_RULES,
  translationContextForFolder,
} from '../src/main/translate/context-injection'
import {
  FIXED_CONTEXT_LEDGER_MAX,
  FixedContextLedger,
  fixedContextHash,
  fixedContextMarker,
} from '../src/main/translate/fixed-context'

/**
 * The fixed part of the translation context (prompts, language pair, editing rules) goes
 * once per conversation only where the provider keeps the earlier system prompt; every
 * other request carries it whole.
 */

let root: string
let settingsPath: string
let dir: string

beforeEach(async () => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'translate-fixed-')))
  settingsPath = join(root, 'app-settings.json')
  dir = (await createProject(root, 'Manual', 'en', 'ko')).dir
  writeTranslationProjects(settingsPath, [{ dir, lastOpened: 1 }])
  writeTranslationSystemPrompt(settingsPath, 'GLOBAL')
  const csv = join(root, 'terms.csv')
  writeFileSync(csv, 'engine,엔진\nwheel,바퀴')
  await addGlossary(dir, csv)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const kept = (id: string) => ({ id, providerKeepsSystem: true })

describe('FixedContextLedger', () => {
  it('sends the fixed text first, then a marker while the hash holds', () => {
    const ledger = new FixedContextLedger()
    const hash = fixedContextHash('FIXED')
    expect(ledger.shouldSend('c1', 'p', hash, true)).toBe(true)
    expect(ledger.shouldSend('c1', 'p', hash, true)).toBe(false)
    expect(ledger.shouldSend('c1', 'p', fixedContextHash('FIXED 2'), true)).toBe(true)
    expect(ledger.shouldSend('c2', 'p', hash, true)).toBe(true)
    // another project in the same conversation is another key
    expect(ledger.shouldSend('c1', 'q', fixedContextHash('FIXED 2'), true)).toBe(true)
  })

  it('always sends for a provider that keeps no earlier system prompt, and records nothing', () => {
    const ledger = new FixedContextLedger()
    const hash = fixedContextHash('FIXED')
    expect(ledger.shouldSend('c1', 'p', hash, false)).toBe(true)
    expect(ledger.shouldSend('c1', 'p', hash, false)).toBe(true)
    // a later session-keeping request still has to send it once
    expect(ledger.shouldSend('c1', 'p', hash, true)).toBe(true)
  })

  it('always sends without a conversation id', () => {
    const ledger = new FixedContextLedger()
    const hash = fixedContextHash('FIXED')
    expect(ledger.shouldSend('', 'p', hash, true)).toBe(true)
    expect(ledger.shouldSend('', 'p', hash, true)).toBe(true)
  })

  it('forgets a conversation, and everything on clear', () => {
    const ledger = new FixedContextLedger()
    const hash = fixedContextHash('FIXED')
    ledger.shouldSend('c1', 'p', hash, true)
    ledger.shouldSend('c2', 'p', hash, true)
    ledger.forget('c1')
    expect(ledger.shouldSend('c1', 'p', hash, true)).toBe(true)
    ledger.clear()
    expect(ledger.shouldSend('c2', 'p', hash, true)).toBe(true)
  })

  it('stays bounded: the oldest conversation is dropped and sends again', () => {
    const ledger = new FixedContextLedger()
    const hash = fixedContextHash('FIXED')
    for (let i = 0; i <= FIXED_CONTEXT_LEDGER_MAX; i++) ledger.shouldSend(`c${i}`, 'p', hash, true)
    expect(ledger.size).toBe(FIXED_CONTEXT_LEDGER_MAX)
    expect(ledger.shouldSend('c0', 'p', hash, true)).toBe(true)
  })

  it('writes the marker as one line with the first 8 hash characters', () => {
    const hash = fixedContextHash('FIXED')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(fixedContextMarker(hash)).toBe(`fixed-context: ${hash.slice(0, 8)}`)
  })
})

describe('translationContextForFolder with a conversation', () => {
  it('first request includes the fixed part; the second in the same conversation omits it', async () => {
    const fixedContext = new FixedContextLedger()
    const first = await translationContextForFolder(
      dir,
      { settingsPath, fixedContext },
      'the engine',
      kept('c1'),
    )
    expect(first?.prompts).toContain('GLOBAL')
    expect(first?.prompts).toContain(TRANSLATION_EDITING_RULES)
    expect(first?.fixedOmitted).toBe(false)
    const second = await translationContextForFolder(
      dir,
      { settingsPath, fixedContext },
      'the wheel',
      kept('c1'),
    )
    expect(second?.fixedOmitted).toBe(true)
    expect(second?.prompts).toBe(`fixed-context: ${first?.fixedHash}`)
    expect(second?.fixedHash).toBe(first?.fixedHash)
    expect(second?.prompts).not.toContain('GLOBAL')
    // the variable part still rides along
    expect(second?.material).toContain('wheel → 바퀴')
  })

  it('editing the project prompt re-sends the fixed part', async () => {
    const fixedContext = new FixedContextLedger()
    await translationContextForFolder(dir, { settingsPath, fixedContext }, '', kept('c1'))
    const project = await loadProject(dir)
    await saveProject(dir, { ...project, projectPrompt: 'Use a formal tone.' })
    const next = await translationContextForFolder(
      dir,
      { settingsPath, fixedContext },
      '',
      kept('c1'),
    )
    expect(next?.fixedOmitted).toBe(false)
    expect(next?.prompts).toContain('Use a formal tone.')
  })

  it('editing the app-wide system prompt re-sends the fixed part', async () => {
    const fixedContext = new FixedContextLedger()
    await translationContextForFolder(dir, { settingsPath, fixedContext }, '', kept('c1'))
    writeTranslationSystemPrompt(settingsPath, 'GLOBAL 2')
    const next = await translationContextForFolder(
      dir,
      { settingsPath, fixedContext },
      '',
      kept('c1'),
    )
    expect(next?.fixedOmitted).toBe(false)
    expect(next?.prompts).toContain('GLOBAL 2')
  })

  it('a new conversation re-sends the fixed part', async () => {
    const fixedContext = new FixedContextLedger()
    await translationContextForFolder(dir, { settingsPath, fixedContext }, '', kept('c1'))
    const next = await translationContextForFolder(
      dir,
      { settingsPath, fixedContext },
      '',
      kept('c2'),
    )
    expect(next?.fixedOmitted).toBe(false)
    expect(next?.prompts).toContain('GLOBAL')
  })

  it('a provider that keeps no session always re-sends the fixed part', async () => {
    const fixedContext = new FixedContextLedger()
    const stateless = { id: 'c1', providerKeepsSystem: false }
    for (let i = 0; i < 3; i++) {
      const context = await translationContextForFolder(
        dir,
        { settingsPath, fixedContext },
        '',
        stateless,
      )
      expect(context?.fixedOmitted).toBe(false)
      expect(context?.prompts).toContain(TRANSLATION_EDITING_RULES)
    }
  })

  it('without a conversation or a ledger the fixed part always goes', async () => {
    const fixedContext = new FixedContextLedger()
    for (let i = 0; i < 2; i++) {
      const noConversation = await translationContextForFolder(dir, { settingsPath, fixedContext })
      expect(noConversation?.fixedOmitted).toBe(false)
      const noLedger = await translationContextForFolder(dir, { settingsPath }, '', kept('c1'))
      expect(noLedger?.fixedOmitted).toBe(false)
    }
  })
})

describe('the PDF translation window', () => {
  it('carries the prompts on every batch: each batch is a request of its own', async () => {
    // translate-ipc.ts builds the PDF instructions with buildTranslationInstructions, no ledger
    for (const text of ['engine', 'wheel', 'engine']) {
      const built = await buildTranslationInstructions(dir, text, { settingsPath })
      expect(built.promptText).toContain('GLOBAL')
    }
  })
})

describe('TRANSLATION_EDITING_RULES', () => {
  it('names the fp fingerprint flow of read_runs and translate_blocks', () => {
    expect(TRANSLATION_EDITING_RULES).toMatch(/"fp"[^\n]*read_runs[^\n]*unchanged/)
  })

  it('tells the model spacing is tidied by the tool and needs no permission', () => {
    expect(TRANSLATION_EDITING_RULES).toMatch(/tidies spacing itself; do not fix spacing by hand/)
    expect(TRANSLATION_EDITING_RULES).not.toMatch(/fix spacing with/)
  })
})
