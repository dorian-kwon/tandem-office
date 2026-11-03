import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { closeAndSaveVideo, launchShell } from './helpers'

/**
 * Translation projects end to end: project list, the global system prompt,
 * create, upload (picked through a stubbed native dialog), the project prompt,
 * the OCR choice, the split translation view with a read-only source pane and
 * the hide toggle, and removing a project from the list.
 *
 * The native open dialog is replaced in the main process; the renderer can only
 * use paths the (stubbed) dialog returned, exactly like a real pick.
 */

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

/** make the next native open dialogs return these absolute paths (consumed in order) */
async function queueDialogPicks(app: ElectronApplication, picks: string[][]) {
  await app.evaluate(({ dialog }, queue) => {
    const g = globalThis as unknown as { __picks?: string[][] }
    g.__picks = queue
    dialog.showOpenDialog = (async () => {
      const next = g.__picks?.shift()
      return next
        ? { canceled: false, filePaths: next }
        : { canceled: true, filePaths: [] as string[] }
    }) as typeof dialog.showOpenDialog
  }, picks)
}

async function openTranslationHome(page: Page) {
  await page.getByRole('button', { name: 'Translation', exact: true }).first().click()
  await expect(page.getByText('Translation projects').first()).toBeVisible()
}

test('translation project: create, upload, split view, read-only source, remove', async () => {
  test.setTimeout(180_000)
  const work = await mkdtemp(join(tmpdir(), 'tp-e2e-'))
  const parentDir = join(work, 'projects')
  await mkdir(parentDir)
  const originalDoc = join(work, 'contract.md')
  const originalBytes = Buffer.from('# Contract\n\nThe supplier shall deliver the goods.\n', 'utf8')
  await writeFile(originalDoc, originalBytes)
  const glossary = join(work, 'terms.csv')
  await writeFile(glossary, 'source,target\nsupplier,공급자\n', 'utf8')
  const reference = join(work, 'style.txt')
  await writeFile(reference, 'Use formal register.\n', 'utf8')

  const launched = await launchShell({
    videoDir: 'translate-projects',
    onboardingSeen: true,
  })
  const { app, page, userDataDir } = launched
  try {
    await queueDialogPicks(app, [])
    await openTranslationHome(page)

    // global system prompt is saved when the field loses focus
    const sys = page.getByLabel('System prompt for all projects')
    await sys.fill('You are a careful legal translator.')
    await sys.blur()
    await expect
      .poll(async () => {
        try {
          const s = JSON.parse(await readFile(join(userDataDir, 'app-settings.json'), 'utf8'))
          return s.translationSystemPrompt
        } catch {
          return undefined
        }
      })
      .toBe('You are a careful legal translator.')

    // create a project (parent folder comes from the stubbed dialog)
    await queueDialogPicks(app, [[parentDir]])
    await page.getByRole('button', { name: 'New project' }).click()
    await page.getByLabel('Project name').fill('Demo contract')
    await page.getByRole('button', { name: 'Choose folder' }).click()
    await expect(page.getByText(parentDir)).toBeVisible()
    await page.getByRole('button', { name: 'Create' }).click()
    const projectDir = join(parentDir, 'Demo contract')
    await expect.poll(() => existsSync(join(projectDir, '.tandem', 'project.json'))).toBe(true)
    for (const sub of ['source', 'references', 'glossary', 'output']) {
      expect(existsSync(join(projectDir, sub))).toBe(true)
    }

    // open the project and add one file of each kind
    await page.getByText('Demo contract').first().click()
    await expect(page.getByText('Documents to translate')).toBeVisible()
    await page.screenshot({ path: join(work, 'detail-empty.png') })

    const addButtons = page.getByRole('button', { name: 'Add files' })
    await queueDialogPicks(app, [[originalDoc]])
    await addButtons.nth(0).click()
    await expect(page.getByText('contract.md').first()).toBeVisible()
    await queueDialogPicks(app, [[reference]])
    await addButtons.nth(1).click()
    await expect(page.getByText('style.txt').first()).toBeVisible()
    await queueDialogPicks(app, [[glossary]])
    await addButtons.nth(2).click()
    await expect(page.getByText('terms.csv').first()).toBeVisible()

    // copies landed in the project, the original is untouched
    expect(await readdir(join(projectDir, 'source'))).toEqual(['contract.md'])
    expect(await readdir(join(projectDir, 'references'))).toEqual(['style.txt'])
    expect(await readdir(join(projectDir, 'glossary'))).toEqual(['terms.csv'])
    const merged = JSON.parse(await readFile(join(projectDir, '.tandem', 'glossary.json'), 'utf8'))
    expect(JSON.stringify(merged)).toContain('supplier')
    expect(sha256(await readFile(originalDoc))).toBe(sha256(originalBytes))

    // project prompt and OCR choice persist in project.json
    const prompt = page.getByLabel('Project prompt')
    await prompt.fill('Keep party names as written.')
    await prompt.blur()
    await expect
      .poll(async () => {
        const p = JSON.parse(await readFile(join(projectDir, '.tandem', 'project.json'), 'utf8'))
        return p.projectPrompt
      })
      .toBe('Keep party names as written.')
    await page.getByLabel('Reading scanned pages (OCR)').selectOption({ label: 'Off' })
    await expect
      .poll(async () => {
        const p = JSON.parse(await readFile(join(projectDir, '.tandem', 'project.json'), 'utf8'))
        return p.ocr?.kind
      })
      .toBe('off')

    // open the translation view: two panes, source read-only on the left
    await page.getByRole('button', { name: 'Open translation' }).first().click()
    await expect
      .poll(
        async () =>
          page.evaluate(
            async () =>
              (
                window as unknown as { aiOfficeTabs: { getSplit(): Promise<unknown> } }
              ).aiOfficeTabs.getSplit() !== null,
          ),
        { timeout: 30_000 },
      )
      .toBe(true)
    const tabs = await page.evaluate(() =>
      (
        window as unknown as {
          aiOfficeTabs: { list(): Promise<{ filePath?: string; title: string }[]> }
        }
      ).aiOfficeTabs.list(),
    )
    const paths = tabs.map((t) => t.filePath).filter(Boolean) as string[]
    expect(paths.some((p) => p.includes(join('source', 'contract.md')))).toBe(true)
    expect(paths.some((p) => p.includes(join('output', 'contract.md')))).toBe(true)
    // the output copy exists and starts identical to the source copy
    expect(sha256(await readFile(join(projectDir, 'output', 'contract.md')))).toBe(
      sha256(originalBytes),
    )
    await page.screenshot({ path: join(work, 'translation-view.png') })

    // both panes (separate views) really show the document text
    const readViews = () =>
      app.evaluate(async ({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        const out: { x: number; width: number; visible: boolean; text: string }[] = []
        for (const v of win.contentView.children as unknown as {
          getBounds(): { x: number; width: number }
          getVisible(): boolean
          webContents: { executeJavaScript(code: string): Promise<string> }
        }[]) {
          const b = v.getBounds()
          const text = await v.webContents
            .executeJavaScript('document.body ? document.body.innerText : ""')
            .catch(() => '')
          out.push({ x: b.x, width: b.width, visible: v.getVisible(), text })
        }
        return out
      })
    await expect
      .poll(
        async () =>
          (await readViews()).filter((v) => v.text.includes('supplier shall deliver')).length,
        { timeout: 30_000 },
      )
      .toBe(2)
    const panes = (await readViews())
      .filter((v) => v.text.includes('supplier shall deliver'))
      .sort((a, b) => a.x - b.x)
    expect(panes[0].x).toBeLessThan(panes[1].x) // source left, translation right

    // the shell marks the source tab read-only and the output tab editable.
    // (Keystroke blocking itself is covered by unit tests: synthetic input from
    // Playwright/CDP bypasses the browser-side key guard, so it proves nothing here.)
    const tabList = await page.evaluate(() =>
      (
        window as unknown as {
          aiOfficeTabs: { list(): Promise<{ filePath?: string; readOnly?: true }[]> }
        }
      ).aiOfficeTabs.list(),
    )
    const sourceTab = tabList.find((t) => t.filePath?.includes(join('source', 'contract.md')))
    const outputTab = tabList.find((t) => t.filePath?.includes(join('output', 'contract.md')))
    expect(sourceTab?.readOnly).toBe(true)
    expect(outputTab?.readOnly).toBeUndefined()

    // hide / show the source pane keeps both tabs alive
    await page.getByRole('button', { name: 'Hide source' }).click()
    await expect(page.getByRole('button', { name: 'Show source' })).toBeVisible()
    await page.getByRole('button', { name: 'Show source' }).click()
    await expect(page.getByRole('button', { name: 'Hide source' })).toBeVisible()

    // back on the project list the document shows under "Recent documents";
    // clicking it reopens the split view
    const splitShown = () =>
      page.evaluate(
        async () =>
          (
            window as unknown as { aiOfficeTabs: { getSplit(): Promise<unknown> } }
          ).aiOfficeTabs.getSplit() !== null,
      )
    await page.locator('.tab-bar .tab-item.tab-home').click()
    await page.getByRole('button', { name: 'Translation', exact: true }).first().click()
    await page.getByRole('button', { name: 'All projects' }).click()
    const recentRow = page.locator('[data-recent-list] [data-recent-file="contract.md"]')
    await expect(page.getByText('Recent documents')).toBeVisible()
    await expect(recentRow).toContainText('Demo contract')
    await recentRow.getByRole('button').click()
    await expect.poll(splitShown, { timeout: 30_000 }).toBe(true)
    await expect(page.getByRole('button', { name: 'Hide source' })).toBeVisible()

    // source copy on disk never changed during all of this
    expect(sha256(await readFile(join(projectDir, 'source', 'contract.md')))).toBe(
      sha256(originalBytes),
    )
    expect((await stat(join(projectDir, 'source', 'contract.md'))).isFile()).toBe(true)
  } finally {
    await closeAndSaveVideo(launched, 'translate-projects')
  }
})
