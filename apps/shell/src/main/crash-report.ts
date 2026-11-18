import { scrubWatchdogDiagnostic } from './watchdog-diagnostics'
import type { TrailItem } from './crash-log'

/**
 * The problem report: one text file the person saves from the Help menu and sends
 * themselves. It gathers the app's own records, all of which stay on this PC, and says
 * plainly what it is. The records already hold no document text, file name or folder path;
 * the update record quotes the installer's and the app's paths, so the name of the PC's user
 * folder is hidden everywhere in the file anyway.
 */

export interface CrashReportInput {
  now: Date
  version: string
  electron: string
  chrome: string
  /** `Windows 10.0.22631` */
  os: string
  arch: string
  language: string
  /** whole seconds the app had been running */
  uptimeS: number
  /** open tabs per editor family */
  tabs: Readonly<Record<string, number>>
  /** this run's actions, oldest first */
  trail: readonly TrailItem[]
  /** `crash-log.jsonl` as it is on disk (empty when there is none) */
  crashLog: string
  /** `sheets-save-failures.jsonl` */
  saveFailureLog: string
  /** `update-log.txt` */
  updateLog: string
  /** newest renderer watchdog JSON records, sanitized again before export */
  watchdogLog?: string
}

const CRASH_LINES = 40
const SAVE_FAILURE_LINES = 20
const UPDATE_LINES = 80
const LINE_MAX_CHARS = 600

/** the name of the PC's user folder replaced by `<user>` (a name may hold spaces) */
export function scrubUserPaths(text: string): string {
  return text
    .replace(/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/"'|\n]+/gi, '$1<user>')
    .replace(/(\/Users\/)[^/"'|\n]+/g, '$1<user>')
    .replace(/(\/home\/)[^/"'|\n]+/g, '$1<user>')
}

/** `45s`, `12m`, `3h 12m` */
export function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** `tandem-office-report-20261118-0905.txt`, in local time */
export function reportFileName(now: Date): string {
  const two = (n: number): string => String(n).padStart(2, '0')
  const date = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`
  return `tandem-office-report-${date}-${two(now.getHours())}${two(now.getMinutes())}.txt`
}

/** the newest `count` non-empty lines, each cut to a sane length; `(none)` when there are none */
function newestLines(text: string, count: number): string {
  const lines = scrubUserPaths(text)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .slice(-count)
    .map((line) => (line.length > LINE_MAX_CHARS ? `${line.slice(0, LINE_MAX_CHARS)}…` : line))
  return lines.length > 0 ? lines.join('\n') : '(none)'
}

export function buildCrashReport(input: CrashReportInput): string {
  const tabs = Object.entries(input.tabs)
    .map(([name, count]) => `${name} ${count}`)
    .join(', ')
  const trail =
    input.trail.length > 0
      ? input.trail.map((item) => `+${item.t}s ${item.a}`).join('\n')
      : '(none)'
  return [
    'tandem office problem report',
    `Made: ${input.now.toISOString()}`,
    'This file holds no document text, file names or folder paths. The person who saved it',
    'chooses whether to send it; the app sent nothing.',
    '',
    '== App ==',
    `version: ${input.version}`,
    `electron: ${input.electron}`,
    `chrome: ${input.chrome}`,
    `os: ${input.os} ${input.arch}`,
    `language: ${input.language}`,
    `running: ${formatUptime(input.uptimeS)}`,
    `open tabs: ${tabs === '' ? 'none' : tabs}`,
    '',
    '== Renderer resource diagnostics (newest 3, private fields removed) ==',
    input.watchdogLog ? scrubWatchdogDiagnostic(input.watchdogLog) : '(none)',
    '',
    '== Recent actions (this run, oldest first) ==',
    trail,
    '',
    `== Crash record (newest ${CRASH_LINES} lines) ==`,
    newestLines(input.crashLog, CRASH_LINES),
    '',
    `== Save failures (newest ${SAVE_FAILURE_LINES} lines) ==`,
    newestLines(input.saveFailureLog, SAVE_FAILURE_LINES),
    '',
    `== Update record (newest ${UPDATE_LINES} lines, user folder name hidden) ==`,
    newestLines(input.updateLog, UPDATE_LINES),
    '',
  ].join('\n')
}
