import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

/**
 * Root cause of the owner's "popup also opens another window and lands on a project detail":
 * the old `showOcr` called revealShellWindow() (which creates or raises the shell window, even
 * when the asking editor lives in a detached window), tabManager.openHomeTab() and sent
 * `translate:event:open-ocr`, which Home turned into the project detail screen.
 * These checks keep that path from coming back.
 */
const src = (rel: string): string => readFileSync(join(__dirname, '..', 'src', rel), 'utf8')

it('the popup wiring in main never reveals/creates a window, opens the home tab or a window', () => {
  const main = src('main/index.ts')
  const from = main.indexOf('const ocrPopupHost = createOcrPopupHost')
  const to = main.indexOf('chatOcrService = createOcrChatService')
  expect(from).toBeGreaterThan(0)
  expect(to).toBeGreaterThan(from)
  const region = main.slice(from, to)
  for (const forbidden of [
    'revealShellWindow',
    'createShellWindow',
    'openHomeTab',
    'new BrowserWindow',
    'activateTab',
  ])
    expect(region).not.toContain(forbidden)
})

it('no screen of the shell listens for an "open the OCR popup" event any more', () => {
  expect(src('renderer/src/Home.tsx')).not.toContain('onOpenOcr')
  expect(src('renderer/src/translate/TranslationPanel.tsx')).not.toContain('ocrRequest')
  expect(src('shared/translate-api.ts')).not.toContain('open-ocr')
  expect(src('preload/index.ts')).not.toContain('onOpenOcr')
})
