import { test, expect } from '@playwright/test'
import { PRODUCT_NAME } from '../packages/i18n/src/product'
import { launchShell, closeAndSaveVideo, screenshotPath } from './helpers'

test.describe('home screen', () => {
  test('home shows file conversion below Translation and opens on the project list', async () => {
    const launched = await launchShell({
      onboardingSeen: true,
      hideUpdateWindows: true,
      videoDir: 'home-basics',
    })
    const { page } = launched
    try {
      // the general entries are hidden in this build (translation-only.ts)
      await expect(page.locator('.sidebar-nav .nav-label')).toHaveText([
        'Translation',
        'File conversion',
      ])
      await expect(page.locator('.home-hero')).toHaveCount(0)
      await expect(page.getByText('Translation projects').first()).toBeVisible()
      await expect(page.locator('.tab-bar .tab-item.tab-home')).toBeVisible()
      // the product name: the window title, the Home tab and the sidebar logo
      expect(PRODUCT_NAME).toBe('Tandem Office')
      await expect(page).toHaveTitle(PRODUCT_NAME)
      await expect(page.locator('.tab-bar .tab-item.tab-home')).toContainText(PRODUCT_NAME)
      await expect(page.locator('img.logo-lockup')).toHaveAttribute('alt', PRODUCT_NAME)
      await page.screenshot({ path: screenshotPath('home-overview') })
    } finally {
      await closeAndSaveVideo(launched, 'home-basics')
    }
  })

  test('renders localized UI when GENOFFICE_LANG=zh-CN', async () => {
    const launched = await launchShell({
      onboardingSeen: true,
      hideUpdateWindows: true,
      lang: 'zh-CN',
      videoDir: 'home-zh-cn',
    })
    const { page } = launched
    try {
      await expect(page.locator('.nav-item .nav-label').first()).toHaveText(/\S/)
      await expect(page.getByTestId('home-file-conversion-nav')).toHaveText('文件转换')
      await page.screenshot({ path: screenshotPath('home-zh-cn') })
    } finally {
      await closeAndSaveVideo(launched, 'home-zh-cn')
    }
  })
})
