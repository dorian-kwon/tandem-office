import { expect, test } from '@playwright/test'
import { closeAndSaveVideo, launchShell, waitForPageWithUrl } from './helpers'

test('opens the split update menu and prepares a selected version in the preview', async () => {
  const launched = await launchShell({
    onboardingSeen: true,
    hideUpdateWindows: true,
    videoDir: 'update-version-picker',
    env: { GENOFFICE_FAKE_UPDATE: '9.9.9' },
  })
  try {
    const page = await waitForPageWithUrl(launched.app, 'update.html')
    const toggle = page.getByRole('button', { name: 'Other versions' })
    await expect(page.getByRole('button', { name: 'Update now' })).toBeVisible()
    await toggle.click()
    const picker = page.getByRole('group', { name: 'Other versions' })
    await expect(picker.getByRole('button')).toHaveCount(5)
    await expect(picker.getByRole('button', { name: /Current/ })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(picker).toBeHidden()
    await expect(toggle).toBeFocused()

    await toggle.click()
    await picker.getByRole('button', { name: 'v9.9.7' }).click()
    await expect(picker).toBeHidden()
    await expect(page.locator('#ver-new')).toHaveText('v9.9.7')
    await page.getByRole('button', { name: 'Install selected version' }).click()
    await expect(page.getByRole('button', { name: 'Restart & install' })).toBeVisible()
    if (process.platform === 'darwin' && process.env.E2E_SHOW_UPDATE_WINDOWS !== '1') {
      await expect
        .poll(() =>
          launched.app.evaluate(({ BrowserWindow, app }) => ({
            visibleWindows: BrowserWindow.getAllWindows().filter((win) => win.isVisible()).length,
            dockVisible: app.dock?.isVisible(),
          })),
        )
        .toEqual({ visibleWindows: 0, dockVisible: false })
    }
  } finally {
    await closeAndSaveVideo(launched, 'update-version-picker')
  }
})
