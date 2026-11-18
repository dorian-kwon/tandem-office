import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'

/**
 * A small crash record kept on this PC only. When a renderer, the GPU process
 * or another child process ends abnormally, or the main process meets an
 * uncaught error, one JSON line goes to `<userData>/crash-log.jsonl`: the time,
 * what ended, Chromium's reason word, the exit code, and which editor it was,
 * plus a few memory figures in whole megabytes. A `low-memory` line records the
 * same figures when the PC runs short of memory while an AI request is running.
 *
 * A line may also say how long the app had run, how many tabs of each editor
 * were open, the last few actions as fixed words (`tab-open:docs`, `ai-start`),
 * and, for a renderer error that leaves the screen alive but broken, the error's
 * class name, its React error number and the function and bundle file of its top
 * frames. All of it is identifier-like.
 *
 * Nothing else is accepted — no document text, path, file name, URL or error
 * message (those can carry a path) — and nothing is ever sent anywhere.
 */

export const CRASH_LOG_FILE = 'crash-log.jsonl'
/** past this size the oldest lines are dropped, keeping about half */
export const CRASH_LOG_MAX_BYTES = 64 * 1024

export type CrashKind =
  | 'renderer'
  | 'renderer-error'
  | 'child-process'
  | 'main-exception'
  | 'main-rejection'
  | 'low-memory'

/** one step of the session's action trail: seconds since the app started, and a fixed word */
export interface TrailItem {
  t: number
  a: string
}

/** memory at the time of the entry; whole numbers only */
export interface CrashMemory {
  /** working set of all the app's own processes, MB */
  appMB?: number
  /** free physical memory of the PC, MB */
  freeMB?: number
  /** physical memory of the PC, MB */
  totalMB?: number
  /** AI requests in flight */
  aiStreams?: number
  /** subscription CLI processes the app is running */
  cliChildren?: number
}

export interface CrashEntry extends CrashMemory {
  kind: CrashKind
  /** Chromium's reason word ('crashed', 'oom', …) or an error class name */
  reason?: string
  exitCode?: number
  /** editor family of the renderer ('docs', 'sheets', …, 'home', 'other') */
  editor?: string
  /** child-process type ('GPU', 'Utility', …) */
  process?: string
  /** whole seconds the app had been running */
  uptimeS?: number
  /** open tabs per editor family: `{ docs: 2, sheets: 1 }` */
  tabs?: Readonly<Record<string, number>>
  /** the session's last actions, oldest first */
  trail?: readonly TrailItem[]
  /** the React error number of a renderer error ('185') */
  code?: string
  /** the top frames of a renderer error: `function@bundle.js:line:column` */
  frames?: readonly string[]
}

// short identifier-like words only: anything else (a message, a path) is dropped
const SAFE_WORD = /^[A-Za-z0-9][A-Za-z0-9 _.:-]{0,47}$/
/** an editor family: `docs`, `sheets`, `home` */
const TAB_NAME = /^[a-z][a-z0-9-]{0,15}$/
/** an action: lower case, no spaces, so no sentence, path or file name fits */
const ACTION_WORD = /^[a-z][a-z0-9:_-]{0,31}$/
const REACT_CODE = /^[0-9]{1,4}$/
/** `function@bundle.js:line:column`; the function may be anonymous, the file has no folder */
const FRAME = /^(?:[A-Za-z_$][\w$.]{0,39})?@[A-Za-z0-9_.-]{1,60}\.(?:js|mjs|cjs):\d{1,7}:\d{1,7}$/

const MAX_TAB_KINDS = 12
const MAX_TAB_COUNT = 999
const MAX_TRAIL = 24
const MAX_FRAMES = 6

function safeWord(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_WORD.test(value) ? value : undefined
}

function wholeNumber(value: unknown, max: number = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max
}

/** whether `action` is a word the action trail accepts */
export function isActionWord(action: unknown): action is string {
  return typeof action === 'string' && ACTION_WORD.test(action)
}

function safeTabs(tabs: unknown): Record<string, number> | undefined {
  if (tabs === null || typeof tabs !== 'object') return undefined
  const kept: Record<string, number> = {}
  for (const [name, count] of Object.entries(tabs)) {
    if (Object.keys(kept).length >= MAX_TAB_KINDS) break
    if (TAB_NAME.test(name) && wholeNumber(count, MAX_TAB_COUNT)) kept[name] = count
  }
  return Object.keys(kept).length > 0 ? kept : undefined
}

function safeTrail(trail: unknown): TrailItem[] | undefined {
  if (!Array.isArray(trail)) return undefined
  const kept: TrailItem[] = []
  for (const item of trail as unknown[]) {
    if (item === null || typeof item !== 'object') continue
    const { t, a } = item as { t?: unknown; a?: unknown }
    if (wholeNumber(t) && isActionWord(a)) kept.push({ t, a })
  }
  return kept.length > 0 ? kept.slice(-MAX_TRAIL) : undefined
}

function safeFrames(frames: unknown): string[] | undefined {
  if (!Array.isArray(frames)) return undefined
  const kept = (frames as unknown[]).filter(
    (frame): frame is string => typeof frame === 'string' && FRAME.test(frame),
  )
  return kept.length > 0 ? kept.slice(0, MAX_FRAMES) : undefined
}

const MEMORY_FIELDS = ['appMB', 'freeMB', 'totalMB', 'aiStreams', 'cliChildren'] as const

/** one log line, holding only the allowed fields */
export function crashLine(entry: CrashEntry, now: Date = new Date()): string {
  const line: Record<string, unknown> = { at: now.toISOString(), kind: entry.kind }
  const reason = safeWord(entry.reason)
  if (reason) line.reason = reason
  if (typeof entry.exitCode === 'number' && Number.isInteger(entry.exitCode)) {
    line.exitCode = entry.exitCode
  }
  const editor = safeWord(entry.editor)
  if (editor) line.editor = editor
  const proc = safeWord(entry.process)
  if (proc) line.process = proc
  for (const key of MEMORY_FIELDS) {
    const value = entry[key]
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) line[key] = value
  }
  if (wholeNumber(entry.uptimeS)) line.uptimeS = entry.uptimeS
  const tabs = safeTabs(entry.tabs)
  if (tabs) line.tabs = tabs
  const trail = safeTrail(entry.trail)
  if (trail) line.trail = trail
  if (typeof entry.code === 'string' && REACT_CODE.test(entry.code)) line.code = entry.code
  const frames = safeFrames(entry.frames)
  if (frames) line.frames = frames
  return `${JSON.stringify(line)}\n`
}

/** the error's class name and code (`TypeError`, `Error:ENOENT`), never its message */
export function errorReason(error: unknown): string {
  if (!(error instanceof Error)) return typeof error
  const name = safeWord(error.name) ?? 'Error'
  const code = safeWord((error as { code?: unknown }).code)
  return code ? `${name}:${code}` : name
}

/** the newest lines of `text` that fit in `budget` bytes */
function tailLines(text: string, budget: number): string {
  const lines = text.split('\n').filter((l) => l.length > 0)
  const kept: string[] = []
  let size = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const bytes = Buffer.byteLength(lines[i]) + 1
    if (size + bytes > budget) break
    kept.unshift(lines[i])
    size += bytes
  }
  return kept.map((l) => `${l}\n`).join('')
}

/** append one entry, trimming the oldest lines once the file passes the cap;
 *  never throws (a crash record must not make things worse) */
export function appendCrashLog(
  filePath: string,
  entry: CrashEntry,
  maxBytes: number = CRASH_LOG_MAX_BYTES,
  now: Date = new Date(),
): void {
  const line = crashLine(entry, now)
  try {
    let size = 0
    try {
      size = statSync(filePath).size
    } catch {
      /* no log yet */
    }
    if (size + Buffer.byteLength(line) > maxBytes) {
      let kept = ''
      try {
        kept = tailLines(readFileSync(filePath, 'utf8'), Math.floor(maxBytes / 2))
      } catch {
        /* unreadable: start over */
      }
      writeFileSync(filePath, kept + line)
    } else {
      appendFileSync(filePath, line)
    }
  } catch {
    /* best effort */
  }
}
