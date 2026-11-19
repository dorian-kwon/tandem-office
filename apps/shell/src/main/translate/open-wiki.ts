import { access, readFile, realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import type { TranslationWikiOpenResult } from '../../shared/translate-api'
import { atomicWriteFile } from '../atomic-write'

interface WikiOptions {
  userDataPath: string
  appDataPath: string
  homePath?: string
  prepareVault: () => Promise<{ vaultPath: string; indexPath: string }>
  handlerName: () => string | Promise<string>
  handlerExecutable?: () => Promise<string>
  openExternal: (url: string) => Promise<void>
  platform?: NodeJS.Platform
  arch?: string
  now?: () => number
  fetch?: typeof fetch
  installedWithoutHandler?: () => Promise<boolean>
}

interface Pending {
  phase: 'download' | 'setup'
  createdAt: number
}

const downloadPage = 'https://obsidian.md/download'
const releases = 'https://github.com/obsidianmd/obsidian-releases/releases/download'
const latest = 'https://api.github.com/repos/obsidianmd/obsidian-releases/releases/latest'
const pendingLifetime = 24 * 60 * 60 * 1000
const doubleClickWindowMs = 1000
const idle: TranslationWikiOpenResult = { status: 'idle', vaultPath: '' }
const waiting: TranslationWikiOpenResult = { ...idle, pending: true }

// The official download page uses universal Windows and Mac installers and separate Linux AppImages.
async function installerUrl(platform: NodeJS.Platform, arch: string, request: typeof fetch) {
  let suffix: string
  if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) suffix = '.dmg'
  else if (platform === 'win32' && ['arm64', 'x64', 'ia32'].includes(arch)) suffix = '.exe'
  else if (platform === 'linux' && arch === 'x64') suffix = '.AppImage'
  else if (platform === 'linux' && arch === 'arm64') suffix = '-arm64.AppImage'
  else return downloadPage
  try {
    const response = await request(latest, { signal: AbortSignal.timeout(4000), redirect: 'error' })
    if (!response.ok) return downloadPage
    const release = await response.json()
    if (!/^v\d+\.\d+\.\d+$/.test(release?.tag_name) || !Array.isArray(release.assets))
      return downloadPage
    const name = 'Obsidian-' + release.tag_name.slice(1) + suffix
    if (release.assets.some((asset: { name?: string }) => asset?.name === name)) {
      return releases + '/' + release.tag_name + '/' + name
    }
  } catch {
    // Offline, rate limited or changed asset layout: let the official page offer the download.
  }
  return downloadPage
}

async function hasInstalledFiles(platform: NodeJS.Platform) {
  let paths: string[] = []
  if (platform === 'darwin') {
    paths = ['/Applications/Obsidian.app', join(homedir(), 'Applications/Obsidian.app')]
  } else if (platform === 'win32') {
    const local = process.env.LOCALAPPDATA
    if (local) paths.push(join(local, 'Programs', 'Obsidian', 'Obsidian.exe'))
    for (const root of [
      process.env.ProgramW6432,
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
    ]) {
      if (root) paths.push(join(root, 'Obsidian', 'Obsidian.exe'))
    }
  } else if (platform === 'linux') {
    paths = [
      '/opt/Obsidian/obsidian',
      '/opt/obsidian/obsidian',
      '/usr/bin/obsidian',
      '/snap/bin/obsidian',
      '/var/lib/flatpak/app/md.obsidian.Obsidian',
      join(homedir(), '.local/share/flatpak/app/md.obsidian.Obsidian'),
      join(homedir(), '.local/bin/obsidian'),
    ]
  }
  return (
    await Promise.all(
      paths.map((file) =>
        access(file).then(
          () => true,
          () => false,
        ),
      ),
    )
  ).some(Boolean)
}

function registryRoots(appData: string, home: string, platform: NodeJS.Platform, handler: string) {
  if (platform !== 'linux') return [appData]
  const flatpak = join(home, '.var/app/md.obsidian.Obsidian/config')
  const snap = join(home, 'snap/obsidian/current/.config')
  if (/md\.obsidian\.obsidian/i.test(handler)) return [flatpak]
  if (/obsidian_obsidian/i.test(handler)) return [snap]
  // Some Linux desktops return only the application display name, without its package ID.
  return /^obsidian$/i.test(handler) ? [appData, flatpak, snap] : [appData]
}

async function isRegistered(roots: string[], platform: NodeJS.Platform, vault: string) {
  const path = platform === 'win32' ? win32 : posix
  const key = (value: string) =>
    platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  const paths = new Set([key(vault), key(await realpath(vault).catch(() => vault))])
  for (const root of roots) {
    try {
      const config = JSON.parse(await readFile(join(root, 'obsidian', 'obsidian.json'), 'utf8'))
      const entries = Object.values(config?.vaults ?? {})
      if (
        entries.some((entry) => {
          const dir = (entry as { path?: unknown } | null)?.path
          return typeof dir === 'string' && path.isAbsolute(dir) && paths.has(key(dir))
        })
      )
        return true
    } catch {
      // Only Obsidian registers a vault. Leave an absent or malformed registry alone.
    }
  }
  return false
}

export function createOpenWikiService(options: WikiOptions) {
  const platform = options.platform ?? process.platform
  const now = options.now ?? Date.now
  const pendingFile = join(options.userDataPath, 'pending-open-wiki.json')
  let pending: Pending | null | undefined
  let opening: Promise<TranslationWikiOpenResult> | undefined
  let resuming: Promise<TranslationWikiOpenResult> | undefined
  let recentLaunch: { uri: string; at: number } | undefined

  async function launchObsidian(uri: string) {
    if (
      recentLaunch?.uri === uri &&
      now() - recentLaunch.at >= 0 &&
      now() - recentLaunch.at < doubleClickWindowMs
    )
      return
    await options.openExternal(uri)
    recentLaunch = { uri, at: now() }
  }

  async function save(value: Pending | null) {
    if (value) await atomicWriteFile(pendingFile, Buffer.from(JSON.stringify(value)))
    else await rm(pendingFile, { force: true })
    pending = value
  }

  async function load() {
    if (pending === undefined) {
      const data = await readFile(pendingFile, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return ''
        throw error
      })
      try {
        const saved = JSON.parse(data)
        pending =
          (saved?.phase === 'download' || saved?.phase === 'setup') &&
          Number.isFinite(saved.createdAt)
            ? saved
            : null
      } catch {
        pending = null
      }
    }
    if (pending && (now() < pending.createdAt || now() - pending.createdAt > pendingLifetime))
      await save(null)
    return pending
  }

  async function run(explicit: boolean): Promise<TranslationWikiOpenResult> {
    let vaultPath = ''
    try {
      const state = await load()
      if (!explicit && !state) return idle
      let handler = (await options.handlerName()).trim()
      // Windows can return a localized association label instead of the executable name.
      if (
        platform === 'win32' &&
        !/^obsidian(?:\.exe)?$/i.test(handler) &&
        options.handlerExecutable
      ) {
        const executable = await options.handlerExecutable().catch(() => '')
        if (win32.basename(executable).toLowerCase() === 'obsidian.exe') handler = 'Obsidian.exe'
      }
      const installed =
        !handler && (await (options.installedWithoutHandler?.() ?? hasInstalledFiles(platform)))
      if (!explicit && !handler && !installed) return waiting
      const vault = await options.prepareVault()
      vaultPath = vault.vaultPath
      const result = (status: TranslationWikiOpenResult['status']) => ({ status, vaultPath })
      if (!handler) {
        if (installed) return result('unavailable')
        if (state?.phase !== 'download' || now() - state.createdAt >= doubleClickWindowMs) {
          const url = await installerUrl(
            platform,
            options.arch ?? process.arch,
            options.fetch ?? fetch,
          )
          await save({ phase: 'download', createdAt: now() })
          await options.openExternal(url)
        }
        return result('download')
      }
      // A different application can claim this scheme. Do not hand it a local path.
      if (
        !/^(?:obsidian(?:\.(?:exe|app|desktop))?|(?:md\.obsidian\.obsidian|obsidian_obsidian|appimagekit[-_][a-z0-9]+-obsidian)\.desktop)$/i.test(
          handler,
        )
      ) {
        return result('unavailable')
      }
      const roots = registryRoots(
        options.appDataPath,
        options.homePath ?? homedir(),
        platform,
        handler,
      )
      if (await isRegistered(roots, platform, vaultPath)) {
        if (state) await save(null)
        await launchObsidian('obsidian://open?path=' + encodeURIComponent(vault.indexPath))
        return result('opened')
      }
      if (!explicit && state?.phase === 'setup') return waiting
      await save({ phase: 'setup', createdAt: state?.createdAt ?? now() })
      await launchObsidian('obsidian://choose-vault')
      return result('setup')
    } catch {
      // A refused browser/URI launch must not be retried automatically on focus or restart.
      await save(null).catch(() => {})
      return { status: 'unavailable', vaultPath }
    }
  }

  return {
    openWiki(): Promise<TranslationWikiOpenResult> {
      if (!opening) {
        const attempt = resuming
          ? resuming.then((value) => (value.status === 'idle' ? run(true) : value))
          : run(true)
        opening = attempt.finally(() => {
          opening = undefined
        })
      }
      return opening
    },
    resumeWiki(): Promise<TranslationWikiOpenResult> {
      if (opening) return opening
      if (!resuming)
        resuming = run(false).finally(() => {
          resuming = undefined
        })
      return resuming
    },
  }
}
