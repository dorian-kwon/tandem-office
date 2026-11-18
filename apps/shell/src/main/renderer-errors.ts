import type { CrashEntry } from './crash-log'

/**
 * Errors thrown inside a page. A renderer that dies is reported by Electron, but an error
 * that only breaks the screen (React unmounting an editor on "Minified React error #185")
 * leaves the process alive and used to leave no trace at all.
 *
 * A small script put in every page reports uncaught errors and unhandled rejections on the
 * console with a tag. The main process reads that line and keeps only what identifies the
 * error: its class name, its React error number, and the function and bundle file of its top
 * frames. The message is dropped (it can quote the document), and so is every path.
 */

export const RENDERER_ERROR_TAG = '@@tandem-error@@'

/** run in the page, once; `window` and `console` are the page's own */
export const RENDERER_ERROR_HOOK = `(() => {
  if (window.__tandemErrorHook) return
  window.__tandemErrorHook = true
  const report = (value) => {
    try {
      const e = value !== null && typeof value === 'object' ? value : {}
      console.error(${JSON.stringify(RENDERER_ERROR_TAG)} + JSON.stringify({
        n: typeof e.name === 'string' ? e.name.slice(0, 48) : '',
        m: typeof e.message === 'string' ? e.message.slice(0, 300) : '',
        s: typeof e.stack === 'string' ? e.stack.slice(0, 3000) : '',
      }))
    } catch (_) {}
  }
  window.addEventListener('error', (event) => report(event.error || { name: 'Error', message: event.message }))
  window.addEventListener('unhandledrejection', (event) => report(event.reason))
})()`

const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_$]{0,39}$/
const FUNCTION_NAME = /^[A-Za-z_$][\w$.]{0,39}$/
const REACT_ERROR = /Minified React error #(\d{1,4})/
// at [async] [function (]url:line:column[)]
const STACK_LINE = /^\s*at\s+(?:async\s+)?(?:(.*?)\s+\()?(.*?):(\d+):(\d+)\)?\s*$/
const SCRIPT = /\.(?:js|mjs|cjs)$/
const MAX_FRAMES = 6

/** `function@bundle.js:line:column` for the first frames that name a script, nothing else */
function parseFrames(stack: string): string[] {
  const frames: string[] = []
  for (const text of stack.split('\n')) {
    if (frames.length >= MAX_FRAMES) break
    const match = STACK_LINE.exec(text)
    if (!match) continue
    const url = (match[2] ?? '').split(/[?#]/)[0] ?? ''
    const file = url.split(/[\\/]/).pop() ?? ''
    if (!SCRIPT.test(file)) continue
    const raw = (match[1] ?? '').replace(/\s*\[as [^\]]*\]$/, '').replace(/^new\s+/, '')
    const name = FUNCTION_NAME.test(raw) ? raw : ''
    frames.push(`${name}@${file}:${match[3]}:${match[4]}`)
  }
  return frames
}

/** the crash entry for a tagged console line, or null when the line is something else */
export function rendererErrorEntry(text: string, editor: string): CrashEntry | null {
  if (!text.startsWith(RENDERER_ERROR_TAG)) return null
  let payload: unknown
  try {
    payload = JSON.parse(text.slice(RENDERER_ERROR_TAG.length))
  } catch {
    return null
  }
  if (payload === null || typeof payload !== 'object') return null
  const { n, m, s } = payload as { n?: unknown; m?: unknown; s?: unknown }
  const entry: CrashEntry = {
    kind: 'renderer-error',
    reason: typeof n === 'string' && ERROR_NAME.test(n) ? n : 'Error',
    editor,
  }
  const code = typeof m === 'string' ? REACT_ERROR.exec(m)?.[1] : undefined
  if (code) entry.code = code
  const frames = typeof s === 'string' ? parseFrames(s) : []
  if (frames.length > 0) entry.frames = frames
  return entry
}

/**
 * Lets an error through at most once a minute, and only so many distinct ones per run:
 * a render loop throws the same error many times a second and must not fill the log.
 */
export function createErrorLimiter(
  options: { now?: () => number; windowMs?: number; maxPerRun?: number } = {},
): (entry: CrashEntry) => boolean {
  const now = options.now ?? Date.now
  const windowMs = options.windowMs ?? 60_000
  const maxPerRun = options.maxPerRun ?? 20
  const lastAt = new Map<string, number>()
  let allowed = 0
  return (entry) => {
    const key = [entry.reason, entry.code, entry.frames?.[0], entry.editor].join('|')
    const at = now()
    const last = lastAt.get(key)
    if (last !== undefined && at - last < windowMs) return false
    if (allowed >= maxPerRun) return false
    lastAt.set(key, at)
    allowed += 1
    return true
  }
}
