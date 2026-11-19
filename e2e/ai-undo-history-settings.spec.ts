import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchShell, closeAndSaveVideo, screenshotPath } from './helpers'

test('home settings gear opens General and AI undo preference survives restart', async () => {
  const launched = await launchShell({
    onboardingSeen: true,
    hideUpdateWindows: true,
    videoDir: 'ai-undo-settings',
  })
  try {
    const { page } = launched
    await page.locator('.account-gear').click()
    const toggle = page.getByRole('switch', { name: 'AI edit undo history', exact: true })
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect
      .poll(async () => {
        const settings = JSON.parse(
          await readFile(join(launched.userDataDir, 'app-settings.json'), 'utf8'),
        )
        return settings.aiEditUndoHistory
      })
      .toBe(false)
    await page.screenshot({ path: screenshotPath('ai-undo-settings-general') })
  } finally {
    await closeAndSaveVideo(launched, 'ai-undo-settings')
  }

  const restarted = await launchShell({
    userDataDir: launched.userDataDir,
    hideUpdateWindows: true,
    videoDir: 'ai-undo-settings-restart',
  })
  try {
    await restarted.page.locator('.account-gear').click()
    const toggle = restarted.page.getByRole('switch', {
      name: 'AI edit undo history',
      exact: true,
    })
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect
      .poll(async () => {
        const settings = JSON.parse(
          await readFile(join(restarted.userDataDir, 'app-settings.json'), 'utf8'),
        )
        return settings.aiEditUndoHistory
      })
      .toBe(true)
  } finally {
    await closeAndSaveVideo(restarted, 'ai-undo-settings-restart')
  }
})
