import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PARSE_SIDECAR_BINARY_NAME = 'ieum-parse-sidecar'

export interface ResolveParseSidecarPathOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly resourcesPath?: string
  readonly platform?: NodeJS.Platform
  readonly exists?: (path: string) => boolean
}

/**
 * Whether the native Rust parse sidecar is enabled.
 * `GENOFFICE_PARSE_SIDECAR=0` or `GENOFFICE_PARSE_SIDECAR=off` (case-insensitive,
 * trimmed) disables the sidecar and forces the existing TypeScript path.
 */
export function isParseSidecarEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.GENOFFICE_PARSE_SIDECAR?.trim().toLowerCase()
  return raw !== '0' && raw !== 'off'
}

/**
 * Resolves the `ieum-parse-sidecar` executable path in precedence order:
 * 1. `GENOFFICE_PARSE_SIDECAR_PATH` environment variable (if non-empty)
 * 2. Packaged app path: `<resourcesPath>/native/<exe>` (if present on disk)
 * 3. Workspace/dev Cargo target paths relative to `packages/file-parse`
 */
export function resolveParseSidecarPath(
  options: ResolveParseSidecarPathOptions = {},
): string | null {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const exists = options.exists ?? existsSync
  const exe = platform === 'win32' ? `${PARSE_SIDECAR_BINARY_NAME}.exe` : PARSE_SIDECAR_BINARY_NAME

  const fromEnv = env.GENOFFICE_PARSE_SIDECAR_PATH?.trim()
  if (fromEnv) return fromEnv

  const resourcesPath =
    'resourcesPath' in options
      ? options.resourcesPath
      : (process as { resourcesPath?: string }).resourcesPath
  if (resourcesPath) {
    const packaged = join(resourcesPath, 'native', exe)
    if (exists(packaged)) return packaged
    if (!(process as { defaultApp?: boolean }).defaultApp) return null
  }

  const modulePath =
    typeof __filename === 'string'
      ? __filename
      : import.meta.url
        ? fileURLToPath(import.meta.url)
        : null
  if (!modulePath) return null
  const moduleDir = dirname(modulePath)
  // Source tests run inside file-parse/src. Electron dev bundles are under
  // apps/<editor>/out/main. Never resolve an executable against the opened folder.
  const candidateRoots = [
    resolve(moduleDir, '..'),
    resolve(moduleDir, '../../../../packages/file-parse'),
    resolve(moduleDir, '../../../../../packages/file-parse'),
  ]

  for (const root of candidateRoots) {
    const candidates = [join(root, 'native', 'parse-sidecar', 'target', 'release', exe)]
    if (platform === 'win32') {
      candidates.push(
        join(root, 'native', 'parse-sidecar', 'target', 'x86_64-pc-windows-gnu', 'release', exe),
        join(root, 'native', 'parse-sidecar', 'target', 'aarch64-pc-windows-msvc', 'release', exe),
      )
    }
    for (const candidate of candidates) {
      if (exists(candidate)) return candidate
    }
  }

  return null
}
