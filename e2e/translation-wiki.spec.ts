import { expect, test } from '@playwright/test'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { closeAndSaveVideo, launchShell } from './helpers'

test('the translation screen connects its own vault once and displays its folder', async () => {
  const launched = await launchShell({
    videoDir: 'translation-wiki',
    hideUpdateWindows: true,
    recordVideo: false,
    onboardingSeen: true,
  })
  const { app, page, userDataDir } = launched
  try {
    // Exercise the production renderer, preload and main. Capture only the external handoff.
    await app.evaluate(({ app, shell }) => {
      const external: string[] = []
      Object.assign(globalThis, { translationWikiExternal: external })
      app.getApplicationNameForProtocol = () => 'Obsidian'
      shell.openExternal = async (url) => {
        external.push(url)
      }
    })
    const externalCalls = () =>
      app.evaluate(
        () =>
          (globalThis as typeof globalThis & { translationWikiExternal: string[] })
            .translationWikiExternal,
      )
    await page.getByRole('button', { name: 'Translation', exact: true }).first().click()
    await page.getByRole('button', { name: 'View wiki', exact: true }).click()
    await expect.poll(externalCalls).toEqual(['obsidian://choose-vault'])
    const vaultPath = join(userDataDir, 'translation-wiki', 'vault')
    await expect(page.getByRole('dialog', { name: 'View wiki' })).toContainText(/Obsidian/)
    await expect(page.getByRole('dialog').getByRole('textbox')).toHaveValue(vaultPath)
    expect(await readFile(join(vaultPath, 'index.md'), 'utf8')).toContain('](terms.md)')
    const result = await page.evaluate(() => window.translateApi!.resumeWiki())
    expect(result.status).toBe('idle')
    expect(await externalCalls()).toEqual(['obsidian://choose-vault'])
  } finally {
    await closeAndSaveVideo(launched, 'translation-wiki')
    await rm(userDataDir, { recursive: true, force: true })
  }
})
