/**
 * Finding ego lite's `ego-browser` command-line program. The order: the PATH,
 * then the standard install places, and a candidate counts only when
 * `ego-browser --version` runs and exits cleanly (through the same no-shell
 * execFile rules as the driver). Nothing is installed or started besides that
 * one version query; the install itself is always the person's own act.
 *
 * The file names below are the documented command name plus the places the
 * installers of a desktop app normally use. They could not be checked against a
 * real install: a miss only shows the "install it?" question, which is safe.
 */
import { posix, win32 } from 'node:path'
import type { EgoDetection } from '../../shared/compare'

export interface EgoDetectDeps {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  homeDir: string
  /** true when a file exists at the path */
  exists(path: string): Promise<boolean>
  /** true when `<path> --version` ran and exited with 0 */
  runsVersion(path: string): Promise<boolean>
}

const COMMAND = 'ego-browser'

/** every place to look, most specific first, without duplicates */
export function egoCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homeDir: string,
): string[] {
  const win = platform === 'win32'
  const path = win ? win32 : posix
  const names = win ? [`${COMMAND}.exe`, `${COMMAND}.cmd`] : [COMMAND]
  const dirs: string[] = []
  const pathVar = env.PATH ?? env.Path ?? ''
  for (const dir of pathVar.split(win ? ';' : ':')) if (dir.trim()) dirs.push(dir.trim())
  if (win) {
    dirs.push(path.join(homeDir, '.local', 'bin'))
    const local = env.LOCALAPPDATA ?? path.join(homeDir, 'AppData', 'Local')
    for (const root of [local, env.ProgramFiles, env['ProgramFiles(x86)']]) {
      if (!root) continue
      for (const folder of ['Programs\\Ego', 'Ego', 'Ego Browser', 'Programs\\Ego Browser']) {
        dirs.push(path.join(root, folder), path.join(root, folder, 'resources', 'bin'))
      }
    }
  } else if (platform === 'darwin') {
    // the CLI installer's own place comes first
    dirs.push(path.join(homeDir, '.local', 'bin'))
    for (const root of ['/Applications', path.join(homeDir, 'Applications')]) {
      for (const app of ['Ego.app', 'Ego Browser.app']) {
        dirs.push(path.join(root, app, 'Contents', 'MacOS'))
        dirs.push(path.join(root, app, 'Contents', 'Resources', 'bin'))
      }
    }
    dirs.push('/usr/local/bin', '/opt/homebrew/bin')
  } else {
    dirs.push(path.join(homeDir, '.local', 'bin'), '/usr/local/bin')
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (const dir of dirs)
    for (const name of names) {
      const full = path.join(dir, name)
      if (!seen.has(full)) {
        seen.add(full)
        out.push(full)
      }
    }
  return out
}

/** the first candidate that exists and answers `--version`, or `{installed:false}` */
export async function detectEgo(deps: EgoDetectDeps): Promise<EgoDetection> {
  for (const candidate of egoCandidates(deps.platform, deps.env, deps.homeDir)) {
    try {
      if (!(await deps.exists(candidate))) continue
      if (await deps.runsVersion(candidate)) return { installed: true, path: candidate }
    } catch {
      /* try the next place */
    }
  }
  return { installed: false }
}
