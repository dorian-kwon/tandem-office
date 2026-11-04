// Source-level wiring: the docs and sheets docks ask the shell which half of
// the translation view they are, and the source pane never writes its closed
// default into the remembered panel state.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '../..')
const read = (p: string) => readFileSync(resolve(root, p), 'utf8')

describe('translation dock wiring', () => {
  for (const [app, api] of [
    ['docs', 'desktop'],
    ['sheets', 'desktopApi'],
  ] as const) {
    it(`${app} dock probes source and output`, () => {
      const src = read(`${app}/src/renderer/ai/use-ai-dock.ts`)
      expect(src).toContain('useTranslationAiDock')
      expect(src).toContain(`window.${api}?.isTranslationSource`)
      expect(src).toContain(`window.${api}?.isTranslationOutput`)
      expect(read(`${app}/src/preload/index.ts`)).toContain('app:is-translation-source')
    })
  }
  it('the source pane does not persist the open state', () => {
    expect(read('docs/src/renderer/App.tsx')).toMatch(/paneKind === 'source'\) return\s+rememberAiPanelOpen\('aidocs/)
    expect(read('sheets/src/renderer/ExcelShell.tsx')).toMatch(
      /paneKind === 'source'\) return\s+rememberAiPanelOpen\('ai-sheets/,
    )
  })
  it('the shell answers the source probe', () => {
    expect(read('shell/src/main/index.ts')).toContain('TRANSLATION_SOURCE_CHANNEL')
  })
})
