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

it('the popup overlay may use every channel its run uses, and an editor tab none of them', async () => {
  const { registerTranslateIpc } = await import('../src/main/translate/translate-ipc')
  const { TRANSLATE_CHANNELS } = await import('../src/shared/translate-api')
  const { createOcrPopupHost } = await import('../src/main/translate/ocr-popup-host')
  const host = createOcrPopupHost({
    mount: () => ({ popupId: 5, destroy: () => undefined }),
    deliver: () => undefined,
  })
  host.open(1, { dir: '/d', file: 'f.xlsx' })
  const answers = new Map<string, (event: { sender: unknown }, ...args: unknown[]) => unknown>()
  registerTranslateIpc(
    { handle: (c: string, fn: never) => void answers.set(c, fn) } as never,
    {
      settingsPath: () => '/nowhere',
      now: () => 0,
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    },
    (sender) => host.isPopupSender((sender as { id: number }).id),
  )
  // everything the overlay calls: project lookup, lease, selection, previews, image read for
  // the model call, recommendation, release, the popup's own result and close
  const used = [
    'getProject',
    'ocrPrepare',
    'ocrStart',
    'ocrPageImage',
    'ocrPreview',
    'ocrPreviewLarge',
    'ocrRecommend',
    'ocrRelease',
    'ocrPopupResult',
    'ocrPopupClosed',
  ] as const
  const refused = async (channel: string, sender: { id: number }): Promise<boolean> =>
    Promise.resolve()
      .then(() => answers.get(channel)!({ sender }, {}))
      .then(
        () => false,
        (err: unknown) => String(err).includes('cannot use the translation tool'),
      )
  for (const key of used) {
    const channel = TRANSLATE_CHANNELS[key]
    expect(answers.has(channel), channel).toBe(true)
    expect(await refused(channel, { id: 5 }), `${channel} from the popup`).toBe(false)
    expect(await refused(channel, { id: 77 }), `${channel} from an editor`).toBe(true)
  }
})

it('no screen of the shell listens for an "open the OCR popup" event any more', () => {
  expect(src('renderer/src/Home.tsx')).not.toContain('onOpenOcr')
  expect(src('renderer/src/translate/TranslationPanel.tsx')).not.toContain('ocrRequest')
  expect(src('shared/translate-api.ts')).not.toContain('open-ocr')
  expect(src('preload/index.ts')).not.toContain('onOpenOcr')
})

it('the chat tool hears of a popup it opened before the sheets AI does, and opens it for the chat session', () => {
  const main = src('main/index.ts')
  // a popup a chat tool waits for is delivered to that tool; any other goes to the sheets AI as before
  expect(main).toMatch(
    /deliver: \(asker, outcome\) => \{\s*if \(!ocrChatPopup\.deliver\(asker, outcome\)\) notifyOcrPopupOutcome\(asker, outcome\)\s*\}/,
  )
  expect(main).toMatch(/createOcrChatPopup\(\{\s*host: ocrPopupHost,\s*allowDir: allowAdHocDir/)
  const service = main.slice(main.indexOf('chatOcrService = createOcrChatService'))
  expect(service.slice(0, 500)).toContain('popup: ocrChatPopup.popup')
})
