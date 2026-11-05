import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * Credentials for the update feed of a private repository. The releases are readable only to
 * people with access to the repository, so the check and the download carry the token of the
 * GitHub CLI login the person already has on this PC (`gh auth token`). The token lives in
 * memory only: it is never written to disk, logged, or sent anywhere but api.github.com
 * through electron-updater. Without `gh` or without a login there is no token and the update
 * check is passed over, as for any other failed check.
 */

const GH_TIMEOUT_MS = 8000
/** a token read stays valid for the session; a failed read is retried after this long */
const RETRY_AFTER_MS = 60_000

/** Where a GUI app (with a short PATH) can still find `gh`. */
export function ghCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const exe = platform === 'win32' ? 'gh.exe' : 'gh'
  const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean)
  if (platform === 'win32') {
    dirs.push(
      join(env.ProgramFiles ?? 'C:\\Program Files', 'GitHub CLI'),
      join(env.LOCALAPPDATA ?? '', 'Programs', 'GitHub CLI'),
    )
  } else {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/snap/bin')
  }
  return [...new Set(dirs.map((dir) => join(dir, exe)))]
}

/** The environment `gh` runs with: where its config lives, and nothing else of ours. */
function ghEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keep = [
    'PATH',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'XDG_CONFIG_HOME',
    'GH_CONFIG_DIR',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'SystemRoot',
  ]
  const out: NodeJS.ProcessEnv = {}
  for (const key of keep) if (env[key] !== undefined) out[key] = env[key]
  return out
}

export type RunGh = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>

const runGh: RunGh = (file, args, env) =>
  new Promise((resolve, reject) => {
    // a real executable, no shell, short timeout
    execFile(file, args, { env, timeout: GH_TIMEOUT_MS, windowsHide: true }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    )
  })

export interface FeedAuth {
  /**
   * What is known without asking: the token, null while a failed read is still fresh, or
   * undefined when the next `token()` call will actually look (lets a check start at once).
   */
  peek(): string | null | undefined
  /** the token for the feed, or null when `gh` is missing or not logged in */
  token(): Promise<string | null>
}

export function createFeedAuth(
  deps: {
    env?: NodeJS.ProcessEnv
    exists?: (path: string) => boolean
    run?: RunGh
    now?: () => number
    platform?: NodeJS.Platform
  } = {},
): FeedAuth {
  const env = deps.env ?? process.env
  const exists = deps.exists ?? existsSync
  const run = deps.run ?? runGh
  const now = deps.now ?? Date.now
  let cached: string | null = null
  let failedAt: number | null = null
  let pending: Promise<string | null> | null = null

  const read = async (): Promise<string | null> => {
    const file = ghCandidates(env, deps.platform).find((path) => exists(path))
    if (!file) return null
    try {
      const out = (await run(file, ['auth', 'token', '--hostname', 'github.com'], ghEnv(env))).trim()
      return /^[\w-]{20,255}$/.test(out) ? out : null
    } catch {
      return null
    }
  }

  return {
    peek() {
      if (cached) return cached
      if (failedAt !== null && now() - failedAt < RETRY_AFTER_MS) return null
      return undefined
    },
    async token() {
      if (cached) return cached
      if (failedAt !== null && now() - failedAt < RETRY_AFTER_MS) return null
      pending ??= read().finally(() => {
        pending = null
      })
      const got = await pending
      if (got) cached = got
      else failedAt = now()
      return got
    },
  }
}
