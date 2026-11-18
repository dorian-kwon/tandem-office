import { describe, expect, it } from 'vitest'
import {
  buildCrashReport,
  formatUptime,
  reportFileName,
  scrubUserPaths,
  type CrashReportInput,
} from '../src/main/crash-report'

/**
 * The problem report is a text file the person saves from the menu and sends themselves.
 * It gathers the app's own records (all kept on this PC), says what they are, and hides the
 * name of the PC's user folder wherever a record quotes a path.
 */

const BASE: CrashReportInput = {
  now: new Date('2026-11-18T02:03:04.000Z'),
  version: '0.15.3',
  electron: '43.7.6',
  chrome: '140.0.1',
  os: 'Windows 10.0.22631',
  arch: 'x64',
  language: 'ko',
  uptimeS: 11_520,
  tabs: { docs: 2, sheets: 1 },
  trail: [
    { t: 0, a: 'app-start' },
    { t: 41, a: 'tab-open:docs' },
  ],
  crashLog: '{"at":"2026-11-18T01:00:00.000Z","kind":"renderer","reason":"oom","editor":"docs"}\n',
  saveFailureLog: '',
  updateLog: '',
}

function build(patch: Partial<CrashReportInput> = {}): string {
  return buildCrashReport({ ...BASE, ...patch })
}

describe('buildCrashReport', () => {
  it('opens with what the file is and that nothing was sent', () => {
    const text = build()
    expect(text.split('\n')[0]).toBe('tandem office problem report')
    expect(text).toContain('Made: 2026-11-18T02:03:04.000Z')
    expect(text).toMatch(/no document text, file names or folder paths/i)
    expect(text).toMatch(/the app sent nothing/i)
  })

  it('lists the app, the system, the run time and the open tabs', () => {
    const text = build()
    expect(text).toContain('version: 0.15.3')
    expect(text).toContain('electron: 43.7.6')
    expect(text).toContain('chrome: 140.0.1')
    expect(text).toContain('os: Windows 10.0.22631 x64')
    expect(text).toContain('language: ko')
    expect(text).toContain('running: 3h 12m')
    expect(text).toContain('open tabs: docs 2, sheets 1')
  })

  it("lists this run's actions oldest first", () => {
    const text = build()
    expect(text).toContain(
      '== Recent actions (this run, oldest first) ==\n+0s app-start\n+41s tab-open:docs\n',
    )
  })

  it('carries the crash record lines as they are', () => {
    expect(build()).toContain(
      '== Crash record (newest 40 lines) ==\n{"at":"2026-11-18T01:00:00.000Z","kind":"renderer","reason":"oom","editor":"docs"}\n',
    )
  })

  it('says "(none)" for a record that is empty', () => {
    const text = build({ trail: [], crashLog: '', tabs: {} })
    expect(text).toContain('== Recent actions (this run, oldest first) ==\n(none)\n')
    expect(text).toContain('== Crash record (newest 40 lines) ==\n(none)\n')
    expect(text).toContain('== Save failures (newest 20 lines) ==\n(none)\n')
    expect(text).toContain('open tabs: none')
  })

  it('keeps only the newest lines of each record', () => {
    const crash = Array.from({ length: 100 }, (_, i) => `{"n":${i}}`).join('\n')
    const update = Array.from({ length: 200 }, (_, i) => `update line ${i}`).join('\n')
    const failures = Array.from({ length: 50 }, (_, i) => `{"f":${i}}`).join('\n')
    const text = build({ crashLog: crash, updateLog: update, saveFailureLog: failures })
    expect(text).toContain('{"n":99}')
    expect(text).toContain('{"n":60}')
    expect(text).not.toContain('{"n":59}')
    expect(text).toContain('update line 199')
    expect(text).toContain('update line 120')
    expect(text).not.toContain('update line 119\n')
    expect(text).toContain('{"f":49}')
    expect(text).not.toContain('{"f":29}')
  })

  it('cuts a very long line', () => {
    const text = build({ updateLog: `error ${'x'.repeat(5000)}` })
    expect(text).toContain('error xxx')
    expect(text).toContain('…')
    expect(text).not.toContain('x'.repeat(700))
  })

  it('hides the user folder name in every record', () => {
    const text = build({
      updateLog: [
        'downloaded to C:\\Users\\Jane Doe\\AppData\\Local\\tandem-office-updater\\pending\\setup.exe',
        'app at file:///C:/Users/jane/AppData/Local/Programs/tandem%20office/resources',
        'cwd /Users/jane/work and /home/jane/.config/tandem office',
      ].join('\n'),
      saveFailureLog: '{"why":"C:\\\\Users\\\\jane\\\\x.xlsx"}',
    })
    expect(text).not.toMatch(/Jane|jane/)
    expect(text).toContain('C:\\Users\\<user>\\AppData\\Local\\tandem-office-updater')
    expect(text).toContain('/Users/<user>/work')
    expect(text).toContain('/home/<user>/.config')
  })
})

describe('scrubUserPaths', () => {
  it('replaces the folder name under Users and home, in either slash style', () => {
    expect(scrubUserPaths('C:\\Users\\kim\\a')).toBe('C:\\Users\\<user>\\a')
    expect(scrubUserPaths('c:/users/kim/a')).toBe('c:/users/<user>/a')
    expect(scrubUserPaths('/Users/kim/a')).toBe('/Users/<user>/a')
    expect(scrubUserPaths('/home/kim/a')).toBe('/home/<user>/a')
  })

  it('takes a name with a space whole', () => {
    expect(scrubUserPaths('C:\\Users\\Kim Min Su\\Desktop')).toBe('C:\\Users\\<user>\\Desktop')
  })

  it('leaves text without a user folder alone and does nothing the second time', () => {
    expect(scrubUserPaths('version 0.15.3 failed')).toBe('version 0.15.3 failed')
    const once = scrubUserPaths('C:\\Users\\kim\\a /home/kim/b')
    expect(scrubUserPaths(once)).toBe(once)
  })
})

describe('formatUptime', () => {
  it('writes seconds, minutes, or hours and minutes', () => {
    expect(formatUptime(0)).toBe('0s')
    expect(formatUptime(59)).toBe('59s')
    expect(formatUptime(60)).toBe('1m')
    expect(formatUptime(3599)).toBe('59m')
    expect(formatUptime(3600)).toBe('1h 0m')
    expect(formatUptime(11_520)).toBe('3h 12m')
  })
})

describe('reportFileName', () => {
  it('names the file by date and time', () => {
    expect(reportFileName(new Date(2026, 10, 18, 9, 5))).toBe(
      'tandem-office-report-20261118-0905.txt',
    )
  })
})
