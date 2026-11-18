import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeAndSaveVideo, launchShell } from './helpers'

/**
 * The problem report against the built app: an error thrown inside a page that leaves the
 * process alive is recorded without its message, and Help → "Save problem report…" writes
 * the records into a file the person chose (the dialogs are answered by the test).
 */

test('a page error is recorded and the Help menu saves a report', async () => {
  const launched = await launchShell({ videoDir: 'problem-report', onboardingSeen: true })
  try {
    const { app, page, userDataDir } = launched
    const log = join(userDataDir, 'crash-log.jsonl')

    // the watch puts its script in the first page a moment after the page is up
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as Record<string, unknown>).__tandemErrorHook),
      )
      .toBe(true)

    // an error that breaks a screen but not its process, quoting a document in its message
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error(
          'Minified React error #185; visit https://react.dev/errors/185 salary-2026.xlsx',
        )
      }, 0)
    })
    await expect
      .poll(async () => (existsSync(log) ? await readFile(log, 'utf8') : ''), { timeout: 20_000 })
      .toContain('renderer-error')

    const raw = await readFile(log, 'utf8')
    const line = JSON.parse(raw.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>
    expect(line).toMatchObject({
      kind: 'renderer-error',
      reason: 'Error',
      editor: 'home',
      code: '185',
    })
    expect(typeof line.uptimeS).toBe('number')
    expect((line.trail as Array<{ a: string }>).map((item) => item.a)).toContain('app-start')
    expect(raw).not.toMatch(/salary|visit|react\.dev/)

    // the Help menu offers the report
    const labels = await app.evaluate(({ Menu }) => {
      const help = Menu.getApplicationMenu()?.items.find((item) => item.role === 'help')
      return help?.submenu?.items.map((item) => item.label) ?? []
    })
    expect(labels).toContain('Save problem report…')

    // choose it, answering both questions: "Save…" and a place for the file
    const target = join(userDataDir, 'report.txt')
    await app.evaluate(({ dialog, Menu }, filePath) => {
      dialog.showMessageBox = (async () => ({
        response: 1,
        checkboxChecked: false,
      })) as typeof dialog.showMessageBox
      let asked = 0
      dialog.showMessageBox = (async () => {
        asked += 1
        // the first question is "Save…"; the "saved" box after it is closed
        return { response: asked === 1 ? 0 : 1, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath,
      })) as typeof dialog.showSaveDialog
      Menu.getApplicationMenu()?.getMenuItemById('menu-save-problem-report')?.click()
    }, target)
    await expect.poll(() => existsSync(target), { timeout: 20_000 }).toBe(true)

    const report = await readFile(target, 'utf8')
    expect(report.startsWith('tandem office problem report')).toBe(true)
    expect(report).toContain('== Crash record')
    expect(report).toContain('renderer-error')
    expect(report).toContain('app-start')
    expect(report).not.toMatch(/salary|visit|react\.dev/)
  } finally {
    await closeAndSaveVideo(launched, 'problem-report')
  }
})
