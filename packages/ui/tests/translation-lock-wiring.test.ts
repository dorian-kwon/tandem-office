/**
 * The editors that can be a translation output lock themselves from the shared
 * run status. This guard reads their sources: the lock hook, the banner with its
 * Unlock button, the bridge to the shell, and (docs) the editor's own editable switch.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO = fileURLToPath(new URL('../../..', import.meta.url))
const source = (path: string): string => readFileSync(join(REPO, path), 'utf8')

describe('translation output lock wiring', () => {
  it('docs: the panel reports the lock and the App switches the editor read-only', () => {
    const panel = source('apps/docs/src/renderer/ai/AiPanel.tsx')
    expect(panel).toMatch(/useTranslationLock\(/)
    expect(panel).toMatch(/<TranslationLockBanner\b/)
    expect(panel).toMatch(/onStop: \(\) => cancelRef\.current\(\)/)
    const app = source('apps/docs/src/renderer/App.tsx')
    expect(app).toMatch(/editor\.setEditable\(!readMode && !isProtected && !translationLocked\)/)
    expect(app).toMatch(/onTranslationLockChange=\{setTranslationLocked\}/)
  })

  it('sheets: the grid goes inert and the banner can stop the run', () => {
    const app = source('apps/sheets/src/renderer/App.tsx')
    expect(app).toMatch(/useTranslationLock\(/)
    expect(app).toMatch(/toggleAttribute\('inert', translationLock\.locked\)/)
    expect(app).toMatch(/<TranslationLockBanner\b/)
    expect(app).toMatch(/agentLoopRef\.current\?\.cancel\(\)/)
  })

  it('the preloads ask the shell through the shared channel', () => {
    for (const app of ['docs', 'sheets']) {
      expect(source(`apps/${app}/src/preload/index.ts`)).toContain(
        "ipcRenderer.invoke('app:is-translation-output')",
      )
    }
  })
})
