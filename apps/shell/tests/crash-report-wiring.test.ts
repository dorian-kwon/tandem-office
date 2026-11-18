import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `index.ts` needs a running Electron, so its wiring is pinned by reading the source (as
 * feedback.test.ts does): the Help menu offers the problem report from every tab kind, the
 * crash line gets its detail, and pages are watched for errors outside headless runs.
 */

const root = resolve(__dirname, '..')
const src = (path: string): string => readFileSync(resolve(root, path), 'utf8')
const index = src('src/main/index.ts')

describe('the Help menu entry', () => {
  it('is added next to the feedback entry in every Help menu that withHelpItems builds', () => {
    expect(index).toMatch(/const CRASH_REPORT_MENU_ID = 'menu-save-problem-report'/)
    expect(index).toMatch(/id: CRASH_REPORT_MENU_ID/)
    expect(index).toMatch(/click: \(\) => void openCrashReport\(\)/)
    // the three places a Help menu is made: a new one, and the two shapes of an existing one
    expect(index).toMatch(/submenu: \[userGuide, \{ type: 'separator' \}, feedback, crashReport\]/)
    expect(index).toMatch(/\[feedback, crashReport, \{ type: 'separator' \}, \{ role: 'undo' \}\]/)
    expect(index).toMatch(
      /feedback,\s+crashReport,\s+\{ type: 'separator' \},\s+\{ role: 'undo' \}/,
    )
  })

  it('leaves the feedback entry as it was', () => {
    expect(index).toMatch(/id: FEEDBACK_MENU_ID/)
    expect(index).toMatch(/click: \(\) => void openFeedbackSurvey\(\)/)
  })

  it('saves through the dialog flow and writes only where the person chose', () => {
    expect(index).toMatch(/await saveCrashReport\(\{/)
    expect(index).toMatch(/showSaveDialog: \(options\) =>/)
    expect(index).toMatch(/writeFile: async \(path, text\) =>/)
    // nothing in the flow sends anything
    const flow = index.slice(
      index.indexOf('async function openCrashReport'),
      index.indexOf('function withHelpItems'),
    )
    expect(flow).not.toMatch(/openExternal|net\.request|fetch\(|clipboard/)
  })

  it('gathers the records the report names', () => {
    expect(index).toMatch(/crashLog: read\(CRASH_LOG_FILE\)/)
    expect(index).toMatch(/saveFailureLog: read\('sheets-save-failures\.jsonl'\)/)
    expect(index).toMatch(/updateLog: read\(UPDATE_LOG_FILE\)/)
    expect(index).toMatch(/trail: activityTrail\.recent\(\)/)
  })
})

describe('the crash line detail and the error watch', () => {
  it('gives every crash line the open tab counts', () => {
    expect(index).toMatch(/tabs: \(\) => tabCounts\(tabManager\?\.list\(\) \?\? \[\]\)/)
  })

  it('notes the tabs that open and close, and the app start and quit', () => {
    expect(index).toMatch(/tabChangeActions\(trailTabs, manager\.list\(\)\)/)
    expect(index).toMatch(/noteActivity\('app-start'\)/)
    expect(index).toMatch(/noteActivity\('app-quit'\)/)
  })

  it('watches the pages for errors, but not in a headless run', () => {
    const at = index.indexOf('startRendererErrorWatch({')
    expect(at).toBeGreaterThan(0)
    expect(index.slice(at - 400, at)).toMatch(/headlessArgv\.kind === 'none'/)
  })

  it('notes the updater and the Explorer helper', () => {
    const updater = src('src/main/updater.ts')
    expect(updater).toMatch(/noteActivity\('update-check'\)/)
    expect(updater).toMatch(/noteActivity\('update-download'\)/)
    expect(updater).toMatch(/noteActivity\('update-install'\)/)
    expect(src('src/main/quick-look/win-explorer-hook.ts')).toMatch(/noteActivity\(/)
  })
})
