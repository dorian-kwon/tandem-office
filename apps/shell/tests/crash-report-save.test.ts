import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { LANGS } from '@genoffice/i18n'
import {
  CRASH_REPORT_STRINGS,
  crashReportText,
  saveCrashReport,
} from '../src/main/crash-report-save'
import type { CrashReportInput } from '../src/main/crash-report'

/**
 * The Help menu's "Save problem report…": say what the file holds, ask where to put it,
 * write it, say where it went. Nothing is written unless the person goes through both
 * questions, and nothing is sent anywhere.
 */

const INPUT: CrashReportInput = {
  now: new Date(2026, 10, 18, 9, 5),
  version: '0.15.3',
  electron: '43.7.6',
  chrome: '140.0.1',
  os: 'Windows 10.0.22631',
  arch: 'x64',
  language: 'ko',
  uptimeS: 90,
  tabs: { docs: 1 },
  trail: [{ t: 0, a: 'app-start' }],
  crashLog: '{"kind":"renderer"}\n',
  saveFailureLog: '',
  updateLog: '',
}

function setup(
  options: {
    answers?: number[]
    saveTo?: string | null
    writeFails?: boolean
  } = {},
) {
  const answers = [...(options.answers ?? [0, 0])]
  const showMessageBox = vi.fn(async () => ({
    response: answers.shift() ?? 1,
    checkboxChecked: false,
  }))
  const saveTo =
    options.saveTo === undefined ? 'C:\\Users\\me\\Downloads\\report.txt' : options.saveTo
  const showSaveDialog = vi.fn(async () => ({ canceled: saveTo === null, filePath: saveTo ?? '' }))
  const showItemInFolder = vi.fn()
  const writeFile = vi.fn(async (_path: string, _text: string) => {
    if (options.writeFails) throw new Error('EPERM')
  })
  const run = () =>
    saveCrashReport({
      lang: 'en',
      downloadsDir: 'C:\\Users\\me\\Downloads',
      input: () => INPUT,
      showMessageBox,
      showSaveDialog,
      showItemInFolder,
      writeFile,
    })
  return { run, showMessageBox, showSaveDialog, showItemInFolder, writeFile }
}

describe('saveCrashReport', () => {
  it('says what the file holds before asking where to save it', async () => {
    const t = setup({ answers: [1] })
    await t.run()
    const first = t.showMessageBox.mock.calls[0]![0] as {
      message: string
      detail: string
      buttons: string[]
    }
    expect(first.message).toBe(crashReportText('en', 'dialogTitle'))
    expect(first.detail).toBe(crashReportText('en', 'dialogBody'))
    expect(first.detail).toMatch(/no document text, file names or folder paths/i)
    expect(first.buttons).toEqual([
      crashReportText('en', 'btnSave'),
      crashReportText('en', 'btnCancel'),
    ])
  })

  it('writes nothing when the person cancels the first question', async () => {
    const t = setup({ answers: [1] })
    expect(await t.run()).toBe('cancelled')
    expect(t.showSaveDialog).not.toHaveBeenCalled()
    expect(t.writeFile).not.toHaveBeenCalled()
  })

  it('writes nothing when the person cancels the save dialog', async () => {
    const t = setup({ saveTo: null })
    expect(await t.run()).toBe('cancelled')
    expect(t.writeFile).not.toHaveBeenCalled()
  })

  it('offers a dated name in the downloads folder and only a text file', async () => {
    const t = setup()
    await t.run()
    expect(t.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: join('C:\\Users\\me\\Downloads', 'tandem-office-report-20261118-0905.txt'),
        filters: [{ name: 'Text', extensions: ['txt'] }],
      }),
    )
  })

  it('writes the report where the person chose and says where it went', async () => {
    const t = setup({ answers: [0, 1] })
    expect(await t.run()).toBe('saved')
    expect(t.writeFile).toHaveBeenCalledTimes(1)
    const [path, text] = t.writeFile.mock.calls[0]!
    expect(path).toBe('C:\\Users\\me\\Downloads\\report.txt')
    expect(text.startsWith('tandem office problem report')).toBe(true)
    expect(text).toContain('version: 0.15.3')
    const last = t.showMessageBox.mock.calls.at(-1)![0] as { message: string; buttons: string[] }
    expect(last.message).toBe(crashReportText('en', 'savedBody'))
    expect(last.buttons).toEqual([
      crashReportText('en', 'btnShow'),
      crashReportText('en', 'btnClose'),
    ])
    expect(t.showItemInFolder).not.toHaveBeenCalled()
  })

  it('shows the file in its folder when asked', async () => {
    const t = setup({ answers: [0, 0] })
    await t.run()
    expect(t.showItemInFolder).toHaveBeenCalledWith('C:\\Users\\me\\Downloads\\report.txt')
  })

  it('tells the person when the file could not be written', async () => {
    const t = setup({ writeFails: true })
    expect(await t.run()).toBe('failed')
    const last = t.showMessageBox.mock.calls.at(-1)![0] as { type: string; message: string }
    expect(last.type).toBe('error')
    expect(last.message).toBe(crashReportText('en', 'failedBody'))
    expect(t.showItemInFolder).not.toHaveBeenCalled()
  })

  it('does not fail when the records cannot be gathered', async () => {
    const t = setup()
    const result = await saveCrashReport({
      lang: 'en',
      downloadsDir: 'C:\\d',
      input: () => {
        throw new Error('records unreadable')
      },
      showMessageBox: t.showMessageBox,
      showSaveDialog: t.showSaveDialog,
      showItemInFolder: t.showItemInFolder,
      writeFile: t.writeFile,
    })
    expect(result).toBe('failed')
    expect(t.writeFile).not.toHaveBeenCalled()
  })
})

describe('the words', () => {
  const KEYS = [
    'menuLabel',
    'dialogTitle',
    'dialogBody',
    'btnSave',
    'btnCancel',
    'savedBody',
    'btnShow',
    'btnClose',
    'failedBody',
  ] as const

  it('exist in every language the app has', () => {
    for (const lang of LANGS) {
      for (const key of KEYS) {
        expect(CRASH_REPORT_STRINGS[lang]?.[key], `${lang}.${key}`).toBeTruthy()
      }
    }
  })

  it('say in every language that nothing is sent', () => {
    // each body is long and says so in its own language; here only that none is a copy of English
    for (const lang of LANGS) {
      if (lang === 'en') continue
      expect(CRASH_REPORT_STRINGS[lang].dialogBody, lang).not.toBe(
        CRASH_REPORT_STRINGS.en.dialogBody,
      )
    }
  })
})

it('includes recent resource diagnostics after consent without private metadata or CPU profiles', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const folder = mkdtempSync(join(tmpdir(), 'report-watchdog-'))
  try {
    writeFileSync(
      join(folder, 'renderer-watchdog-1000000000000.json'),
      JSON.stringify({
        memoryMB: 2000,
        document: { kind: 'docs', title: 'secret-title', filePath: '/private/secret.docx' },
        metric: { memory: { privateBytes: 2048000 } },
      }),
    )
    writeFileSync(join(folder, 'renderer-watchdog-1000000000001.cpuprofile'), 'secret-profile')
    const writeFile = vi.fn(async (_path: string, _text: string) => {})
    await saveCrashReport({
      lang: 'en',
      downloadsDir: folder,
      userDataDir: folder,
      input: () => INPUT,
      showMessageBox: async () => ({ response: 0 }),
      showSaveDialog: async () => ({ canceled: false, filePath: join(folder, 'report.txt') }),
      showItemInFolder: () => {},
      writeFile,
    })
    const report = writeFile.mock.calls[0]![1]
    expect(report).toContain('2000')
    expect(report).toContain('privateBytes')
    expect(report).not.toMatch(/secret-title|secret\.docx|secret-profile|\/private/)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})
