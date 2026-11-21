import { test, expect } from '@playwright/test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { closeAndSaveVideo, launchShell } from './helpers'

test('batch conversion writes PDFs beside their sources and keeps an existing output', async () => {
  const info = test.info()
  const first = info.outputPath('first')
  const second = info.outputPath('second')
  await Promise.all([mkdir(first, { recursive: true }), mkdir(second, { recursive: true })])
  const markdown = join(first, 'report.md')
  const html = join(second, 'report.html')
  const inputs = ['# First report\n\nA short document.', '<html><body>Second report</body></html>']
  const existing = join(first, 'report.pdf')
  await Promise.all([
    writeFile(markdown, inputs[0]),
    writeFile(html, inputs[1]),
    writeFile(existing, 'existing file'),
  ])
  const launched = await launchShell({
    onboardingSeen: true,
    hideUpdateWindows: true,
    recordVideo: false,
    videoDir: 'file-conversion',
  })
  try {
    const { app, page } = launched
    await app.evaluate(
      ({ dialog }, picks) => {
        dialog.showOpenDialog = async () => {
          const paths = picks.shift()
          return { canceled: !paths, filePaths: paths ?? [] }
        }
      },
      [[markdown], [markdown, html]],
    )
    await page.getByTestId('home-file-conversion-nav').click()
    await page.getByTestId('file-conversion-pick').click()
    const files = page.getByTestId('file-conversion-file')
    await expect(files).toHaveCount(1)
    await page.getByTestId('file-conversion-pick').click()
    await expect(files).toHaveCount(2)
    await page.getByTestId('file-conversion-pick').click()
    await expect(files).toHaveCount(2)
    const target = page.getByTestId('file-conversion-target')
    await expect(target.locator('option[value="html"]')).toHaveCount(0)
    await target.selectOption('pdf')
    await page.getByTestId('file-conversion-run').click()

    const destinations = [join(first, 'report (2).pdf'), join(second, 'report.pdf')]
    for (const [index, path] of destinations.entries()) {
      await expect(files.nth(index)).toContainText(path, { timeout: 60_000 })
      expect((await readFile(path)).subarray(0, 5).toString('ascii')).toBe('%PDF-')
    }
    expect(await readFile(existing, 'utf8')).toBe('existing file')
    expect(await Promise.all([readFile(markdown, 'utf8'), readFile(html, 'utf8')])).toEqual(inputs)
  } finally {
    await closeAndSaveVideo(launched, 'file-conversion')
    await rm(launched.userDataDir, { recursive: true, force: true })
  }
})
