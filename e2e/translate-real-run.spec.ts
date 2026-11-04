import { test, expect, type Page } from '@playwright/test'
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import type { ElectronApplication } from 'playwright-core'
import { closeAndSaveVideo, launchShell } from './helpers'

/**
 * ONE real translation run through the built app on this PC's main AI setting. Spends the person's quota: runs only with
 * IEUM_TRANSLATE_REAL=1. Not part of the suite.
 */
const REAL = process.env.IEUM_TRANSLATE_REAL === '1'
const SRC_PROJECT = '/Users/dorian/Documents/tandem office/test/번역프로젝트'
const DOC = '공간 속의 기호_도록용_이민수.docx'
const OUT_DIR =
  process.env.REAL_RUN_OUT ??
  '/private/tmp/claude-501/-Users-dorian-Projects-tandem2/2cbfc8e3-3205-43ba-bb7d-a50bd4094fd0/scratchpad/real-run'
const RUN_TIMEOUT = 15 * 60_000

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

function descendants(pid: number): string[] {
  const out = execSync('ps -axo pid=,ppid=,comm=').toString()
  const rows = out
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/, 3))
    .map(([p, pp, c]) => ({ pid: Number(p), ppid: Number(pp), comm: c ?? '' }))
  const found: string[] = []
  const walk = (parent: number) => {
    for (const r of rows)
      if (r.ppid === parent) {
        found.push(`${r.pid} ${r.comm}`)
        walk(r.pid)
      }
  }
  walk(pid)
  return found
}

/** the app's user-data folder holding the person's ai-settings.json (override: IEUM_REAL_USER_DATA) */
function realAiSettingsPath(): string | null {
  const home = homedir()
  const roots = [
    process.env.IEUM_REAL_USER_DATA,
    ...['tandem office', 'tandem office-Dev'].flatMap((name) => [
      join(home, 'Library', 'Application Support', name),
      join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), name),
      join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), name),
    ]),
  ]
  for (const root of roots) {
    if (root && existsSync(join(root, 'ai-settings.json'))) return join(root, 'ai-settings.json')
  }
  return null
}

test.skip(!REAL, 'spends the subscription; set IEUM_TRANSLATE_REAL=1')

/** newest modification time (ms) of any file under `dir`, 0 when it does not exist */
function newestMtime(dir: string): number {
  let newest = 0
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const full = join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else newest = Math.max(newest, statSync(full).mtimeMs)
    }
  }
  if (existsSync(dir)) walk(dir)
  return newest
}

/**
 * The shell loads each editor from its own build output (apps/docs/out): a run
 * against an output older than its source tests code that is no longer there
 * (real run 4 used a docs renderer built before the notes tools existed).
 */
function assertBuildsAreFresh(): void {
  for (const app of ['docs', 'shell']) {
    const src = newestMtime(join('apps', app, 'src'))
    const out = newestMtime(join('apps', app, 'out'))
    if (out < src)
      throw new Error(
        `apps/${app}/out is older than apps/${app}/src: run "npm run build:all" before a real run`,
      )
  }
}

test('real translation run (the machine main AI setting)', async () => {
  test.setTimeout(RUN_TIMEOUT + 5 * 60_000)
  assertBuildsAreFresh()
  await mkdir(OUT_DIR, { recursive: true })
  const log: Record<string, unknown> = {}
  const note = (k: string, v: unknown) => {
    log[k] = v
    console.log(`[real-run] ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
  }
  const work = await mkdtemp(join(tmpdir(), 'tp-real-'))
  // copy of the person's project inputs (source/ and project.json only)
  const copyDir = join(work, 'copy-of-project')
  await cp(join(SRC_PROJECT, 'source'), join(copyDir, 'source'), { recursive: true })
  await mkdir(join(copyDir, '.tandem'), { recursive: true })
  await copyFile(
    join(SRC_PROJECT, '.tandem', 'project.json'),
    join(copyDir, '.tandem', 'project.json'),
  )
  const pickDoc = join(copyDir, 'source', DOC)
  const parentDir = join(work, 'projects')
  await mkdir(parentDir)
  const userDataDir = await mkdtemp(join(tmpdir(), 'tp-real-data-'))
  // the machine's own main AI setting (provider, model, notice flags), copied the way the
  // app stores it; nothing is seeded here and no login file of any program is touched
  const settingsSource = realAiSettingsPath()
  if (!settingsSource)
    throw new Error(
      'no ai-settings.json found; set IEUM_REAL_USER_DATA to the app user-data folder',
    )
  await copyFile(settingsSource, join(userDataDir, 'ai-settings.json'))
  const chosen = JSON.parse(await readFile(join(userDataDir, 'ai-settings.json'), 'utf8')) as {
    provider?: string
  }
  note('provider (from the machine setting)', chosen.provider ?? '(default)')
  note('work', work)
  note('userDataDir', userDataDir)

  const launched = await launchShell({
    userDataDir,
    videoDir: 'translate-real',
    onboardingSeen: true,
  })
  const { app, page } = launched
  const appPid = app.process().pid!
  const projectDir = join(parentDir, 'Real run')
  const outputDoc = join(projectDir, 'output', DOC)
  try {
    await queueDialogPicks(app, [])
    await page.getByRole('button', { name: 'Translation', exact: true }).first().click()
    await expect(page.getByText('Translation projects').first()).toBeVisible()
    await queueDialogPicks(app, [[parentDir]])
    await page.getByRole('button', { name: 'New project' }).click()
    await page.getByLabel('Project name').fill('Real run')
    await page.getByRole('button', { name: 'Choose folder' }).click()
    await expect(page.getByText(parentDir)).toBeVisible()
    await page.getByRole('button', { name: 'Create' }).click()
    await expect.poll(() => existsSync(join(projectDir, '.tandem', 'project.json'))).toBe(true)
    await page.getByText('Real run').first().click()
    await expect(page.getByText('Documents to translate')).toBeVisible()
    await queueDialogPicks(app, [[pickDoc]])
    await page.getByRole('button', { name: 'Add files' }).nth(0).click()
    await expect(page.getByText(DOC).first()).toBeVisible()
    note(
      'project.json',
      JSON.parse(await readFile(join(projectDir, '.tandem', 'project.json'), 'utf8')),
    )
    await page.screenshot({ path: join(OUT_DIR, '01-detail.png') })

    await page.getByRole('button', { name: 'Open translation' }).first().click()
    await expect
      .poll(
        async () =>
          page.evaluate(
            async () =>
              (await (
                window as unknown as { aiOfficeTabs: { getSplit(): Promise<unknown> } }
              ).aiOfficeTabs.getSplit()) !== null,
          ),
        { timeout: 60_000 },
      )
      .toBe(true)
    await expect.poll(() => existsSync(outputDoc), { timeout: 30_000 }).toBe(true)
    const outBefore = await stat(outputDoc)
    note('outputBefore', { size: outBefore.size, mtime: outBefore.mtimeMs })

    // mark the right-hand (output) view so its Playwright page can be found
    await expect
      .poll(
        async () =>
          app.evaluate(async ({ BrowserWindow }) => {
            const win = BrowserWindow.getAllWindows()[0]
            const views = (
              win.contentView.children as unknown as {
                getBounds(): { x: number; width: number }
                getVisible(): boolean
                webContents: { getURL(): string; executeJavaScript(code: string): Promise<unknown> }
              }[]
            ).filter((v) => v.webContents.getURL().includes('://docs/') && v.getVisible())
            if (views.length < 2) return 0
            views.sort((a, b) => a.getBounds().x - b.getBounds().x)
            await views[0].webContents.executeJavaScript('window.__pane = "left"')
            await views[views.length - 1].webContents.executeJavaScript('window.__pane = "right"')
            return views.length
          }),
        { timeout: 60_000 },
      )
      .toBeGreaterThanOrEqual(2)
    let editor: Page | undefined
    for (let i = 0; i < 60 && !editor; i++) {
      for (const w of app.windows()) {
        const pane = await w
          .evaluate(() => (window as unknown as { __pane?: string }).__pane)
          .catch(() => undefined)
        if (pane === 'right') editor = w
      }
      if (!editor) await new Promise((r) => setTimeout(r, 500))
    }
    if (!editor) throw new Error('output docs page not found')
    await editor.locator('.doc-page[contenteditable="true"]').first().waitFor({ timeout: 60_000 })
    await page.screenshot({ path: join(OUT_DIR, '02-split.png') })

    const composer = editor.locator('.ai-composer textarea')
    if (!(await composer.isVisible().catch(() => false))) {
      note('composerHidden', 'AI panel composer not visible in output pane')
      await editor.screenshot({ path: join(OUT_DIR, '02b-no-composer.png') })
    }
    await composer.waitFor({ timeout: 30_000 })
    await expect(editor.getByText('Before you use AI with your subscription')).toHaveCount(0)
    const stop = editor.locator('.ai-stop-btn')
    const t0 = Date.now()
    await composer.fill('번역 시작해줘')
    await composer.press('Enter')
    note('sentAt', new Date(t0).toISOString())
    await expect(editor.getByText('Before you use AI with your subscription')).toHaveCount(0)
    await expect(stop).toBeVisible({ timeout: 60_000 })
    let finished = false
    let lastShot = Date.now()
    const kids: string[] = []
    while (Date.now() - t0 < RUN_TIMEOUT) {
      if (!(await stop.isVisible().catch(() => false))) {
        finished = true
        break
      }
      for (const d of descendants(appPid).filter((l) => /claude|codex/i.test(l)))
        if (!kids.includes(d)) kids.push(d)
      if (Date.now() - lastShot > 120_000) {
        lastShot = Date.now()
        await editor
          .screenshot({
            path: join(OUT_DIR, `03-progress-${Math.round((Date.now() - t0) / 1000)}s.png`),
          })
          .catch(() => {})
      }
      await new Promise((r) => setTimeout(r, 3000))
    }
    note('childrenDuringRun', kids)
    ;(globalThis as unknown as { __kids?: string[] }).__kids = kids
    note('runSeconds', Math.round((Date.now() - t0) / 1000))
    note('finished', finished)
    await editor.screenshot({ path: join(OUT_DIR, '04-after-run.png') })
    note('errors', await editor.locator('.ai-msg-error').allInnerTexts())
    const panelText = await editor
      .evaluate(() => {
        const el = document
          .querySelector('.ai-composer')
          ?.closest('aside, section, div[class*="ai-panel"]') as HTMLElement | null
        return (el ?? document.body).innerText.slice(-4000)
      })
      .catch(() => '')
    await writeFile(join(OUT_DIR, 'panel-tail.txt'), panelText)
    if (!finished) {
      await stop.click().catch(() => {})
      note('stopped', 'run exceeded timeout; pressed stop')
    }

    // save in place
    await editor
      .locator('.doc-page[contenteditable="true"]')
      .first()
      .click({ position: { x: 5, y: 5 } })
      .catch(() => {})
    await editor.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
    await expect
      .poll(async () => (await stat(outputDoc)).mtimeMs, { timeout: 60_000 })
      .toBeGreaterThan(outBefore.mtimeMs)
    await new Promise((r) => setTimeout(r, 2000))
    const outAfter = await stat(outputDoc)
    note('outputAfter', { size: outAfter.size, mtime: outAfter.mtimeMs })
    await copyFile(outputDoc, join(OUT_DIR, 'output.docx'))
    await copyFile(pickDoc, join(OUT_DIR, 'source.docx'))
    const chatsDir = join(projectDir, '.ieumoffice', 'chats')
    if (existsSync(chatsDir)) {
      await cp(chatsDir, join(OUT_DIR, 'chats'), { recursive: true })
      note('chats', await readdir(chatsDir))
    } else note('chats', 'none at ' + chatsDir)
    // usage the app might record
    note('userDataFiles', await readdir(userDataDir))
  } finally {
    await closeAndSaveVideo(launched, 'translate-real').catch(() => {})
    await new Promise((r) => setTimeout(r, 3000))
    const left = descendants(appPid)
    note('descendantsAfterClose', left)
    const seen = (globalThis as unknown as { __kids?: string[] }).__kids ?? []
    const alive = seen.filter((l) => {
      try {
        process.kill(Number(l.split(' ')[0]), 0)
        return true
      } catch {
        return false
      }
    })
    note('runChildrenStillAlive', alive)
    const ps = execSync('ps -axo pid=,ppid=,command=').toString()
    note(
      'claudeCodexWithUserData',
      ps
        .split('\n')
        .filter((l) => l.includes(userDataDir) || (l.includes(work) && /claude|codex/.test(l))),
    )
    await writeFile(join(OUT_DIR, 'run-log.json'), JSON.stringify(log, null, 2))
  }
})
