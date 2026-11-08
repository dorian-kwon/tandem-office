/**
 * The real CompareDriver: asks one AI website through ego lite's command-line
 * program. Rules this file keeps:
 *  - the program is started from its resolved path with an argument list
 *    (`ego-browser nodejs`), never through a shell;
 *  - the environment is an allow-list (no API keys or tokens of any kind), and
 *    nothing here reads a cookie, token or login of ego lite or of a site: the
 *    page is driven through ego lite, which holds the person's own login;
 *  - the script goes in on stdin, the prompt inside it as JSON data
 *    (see ego-script.ts);
 *  - output is captured up to a size cap, the whole run has a hard timeout,
 *    aborting kills the process tree, and every child dies with the app.
 */
import type { CompareSite } from '../../shared/compare-sites'
import type { CompareAnswer, CompareDriver, EgoDetection } from '../../shared/compare'
import { COMPARE_NEEDS_USER, isBlockReason } from '../../shared/compare'
import { buildEgoScript, parseEgoOutput } from './ego-script'

/** the part of a child process the driver uses (a fake in tests) */
export interface EgoChild {
  readonly pid?: number | undefined
  stdin: {
    write(data: string): unknown
    end(): unknown
    on(event: string, cb: () => void): unknown
  }
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown }
  stderr: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown }
  on(event: 'close', cb: (code: number | null) => void): unknown
  on(event: 'error', cb: (error: Error) => void): unknown
}

export interface EgoDriverDeps {
  detect(): Promise<EgoDetection>
  /** start the program: no shell, own process group where the platform has one */
  spawn(command: string, args: string[], env: NodeJS.ProcessEnv): EgoChild
  /** end the child and everything it started */
  killTree(child: EgoChild): void
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  /** a fresh random token per run */
  nonce(): string
  /** slack added to the site's own timeouts before the process is killed */
  graceMs?: number
}

/** captured stdout is capped: the result line is at the end, so the tail is what stays */
export const EGO_OUTPUT_CAP = 2 * 1024 * 1024
// ego lite prints what a script logs on stderr (not stdout) when it is not run from a terminal,
// so the result line can arrive there and answers can be long: both streams get the full cap
const STDERR_CAP = EGO_OUTPUT_CAP

const ENV_ALLOW = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'TEMP',
  'TMP',
  'TMPDIR',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'LANG',
  'LC_ALL',
  'USER',
  'LOGNAME',
  'USERNAME',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'DISPLAY',
  'WAYLAND_DISPLAY',
]

/** the environment the program gets: only what a desktop tool needs to find its own files */
export function egoChildEnv(base: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const allow = new Set(ENV_ALLOW)
  const out: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue
    if (allow.has(platform === 'win32' ? name.toUpperCase() : name)) out[name] = value
  }
  return out
}

function appendCapped(buffer: string, chunk: Buffer | string, cap: number): string {
  const next = buffer + chunk.toString()
  return next.length > cap ? next.slice(next.length - cap) : next
}

/** the first useful line of a failing program's stderr, short enough for a status row */
function firstLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean)
  return line ? line.slice(0, 200) : ''
}

export function createEgoDriver(deps: EgoDriverDeps): CompareDriver {
  const grace = deps.graceMs ?? 60_000
  return {
    detect: deps.detect,
    async ask(site: CompareSite, prompt: string, signal: AbortSignal): Promise<CompareAnswer> {
      if (signal.aborted) return { ok: false, reason: 'stopped' }
      const found = await deps.detect()
      if (signal.aborted) return { ok: false, reason: 'stopped' }
      if (!found.installed || !found.path)
        return { ok: false, reason: 'ego browser is not installed' }
      const marker = `@@TANDEM_COMPARE_${deps.nonce()}@@`
      const script = buildEgoScript({ site, prompt, marker })
      let child: EgoChild
      try {
        child = deps.spawn(found.path, ['nodejs'], egoChildEnv(deps.env, deps.platform))
      } catch (error) {
        return {
          ok: false,
          reason: `could not start the ego browser: ${String(error)}`.slice(0, 200),
        }
      }
      return new Promise<CompareAnswer>((resolve) => {
        let stdout = ''
        let stderr = ''
        let settled = false
        const finish = (answer: CompareAnswer): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          resolve(answer)
        }
        const stop = (reason: string): void => {
          deps.killTree(child)
          finish({ ok: false, reason })
        }
        const onAbort = (): void => stop('stopped')
        const timer = setTimeout(
          () => stop('the ego browser took too long'),
          site.loadTimeoutMs + site.answerTimeoutMs + grace,
        )
        signal.addEventListener('abort', onAbort, { once: true })
        child.stdout.on('data', (chunk) => (stdout = appendCapped(stdout, chunk, EGO_OUTPUT_CAP)))
        child.stderr.on('data', (chunk) => (stderr = appendCapped(stderr, chunk, STDERR_CAP)))
        child.on('error', (error) =>
          finish({
            ok: false,
            reason: `could not run the ego browser: ${error.message}`.slice(0, 200),
          }),
        )
        child.on('close', (code) => {
          // the result line is read from both streams: where ego prints it depends on how it runs
          const outcome = parseEgoOutput(`${stdout}\n${stderr}`, marker)
          // ego lite prints this when a newer version exists; it is passed on, never acted on
          const update = stdout.includes('[ego-browser:notice]')
            ? ' (an ego lite update is available)'
            : ''
          if (outcome.ok) {
            finish(
              outcome.text.trim() === ''
                ? { ok: false, reason: 'the answer was empty' }
                : { ok: true, text: outcome.text.trim() },
            )
            return
          }
          // a code reason is passed on untouched: the popup treats it as "blocked"
          if (isBlockReason(outcome.reason)) {
            finish({ ok: false, reason: outcome.reason })
            return
          }
          // ego-browser itself exits like this when it gave the space to the person
          if (/user now controls/i.test(`${stderr}\n${stdout}`)) {
            finish({ ok: false, reason: COMPARE_NEEDS_USER })
            return
          }
          const detail = code === 0 ? '' : firstLine(stderr)
          finish({
            ok: false,
            reason: `${outcome.reason}${detail ? `: ${detail}` : ''}${update}`,
          })
        })
        child.stdin.on('error', () => {})
        child.stdin.write(script)
        child.stdin.end()
      })
    },
  }
}
