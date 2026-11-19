import { GITHUB_REPO_SLUG, GITHUB_RELEASES_URL } from '@genoffice/electron-utils'
import type { UpdateInfo } from 'electron-updater'
import type { UpdateChannel } from '../shared/update-api'

const RELEASE_API = `https://api.github.com/repos/${GITHUB_REPO_SLUG}/releases`
const VERSION_TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?)$/
const RECENT_VERSION_COUNT = 5

export interface VersionPlatform {
  platform: NodeJS.Platform
  arch: string
  appImage: boolean
}

interface ReleaseAsset {
  id: number
  name: string
}

export interface VersionCandidate {
  version: string
  prerelease: boolean
  install: 'in-app' | 'manual'
  installer: ReleaseAsset
  feed?: ReleaseAsset
}

function uploadedAsset(assets: unknown[], name: string): ReleaseAsset | undefined {
  for (const asset of assets) {
    const row = asset as Record<string, unknown> | null
    if (
      row?.name === name &&
      row.state === 'uploaded' &&
      typeof row.id === 'number' &&
      Number.isSafeInteger(row.id) &&
      row.id > 0
    )
      return { id: row.id, name }
  }
  return undefined
}

function platformAssets(version: string, { platform, arch, appImage }: VersionPlatform) {
  if (platform === 'win32' && arch === 'x64') {
    return { installers: [`tandem-office-Setup-${version}.exe`], feed: 'latest.yml' }
  }
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) {
    return { installers: [`tandem-office-${version}-${arch}.dmg`] }
  }
  if (platform === 'linux' && arch === 'x64') {
    const image = `tandem-office-${version}.AppImage`
    if (appImage) return { installers: [image], feed: 'latest-linux.yml' }
    return {
      installers: [
        `tandem-office_${version}_amd64.deb`,
        `tandem-office-${version}.x86_64.rpm`,
        image,
      ],
    }
  }
  return null
}

/** Keep only releases that can be installed on this build's platform and channel. */
export function chooseRecentVersions(
  releases: unknown,
  channel: UpdateChannel,
  platform: VersionPlatform,
): VersionCandidate[] {
  if (!Array.isArray(releases)) throw new Error('Invalid GitHub release list')
  const ordered = releases
    .filter((row) => typeof row?.published_at === 'string' && typeof row?.tag_name === 'string')
    .sort((a, b) => b.published_at.localeCompare(a.published_at))
  const candidates = new Map<string, VersionCandidate>()
  for (const release of ordered) {
    if (release.draft !== false || typeof release.prerelease !== 'boolean') continue
    if (release.prerelease && channel === 'stable') continue
    const version = release.tag_name.length <= 80 && VERSION_TAG.exec(release.tag_name)?.[1]
    if (!version || candidates.has(version) || !Array.isArray(release.assets)) continue
    const names = platformAssets(version, platform)
    if (!names) continue
    const installer = names.installers
      .map((name) => uploadedAsset(release.assets, name))
      .find((asset) => asset !== undefined)
    const feed = names.feed ? uploadedAsset(release.assets, names.feed) : undefined
    if (!installer || (names.feed && !feed)) continue
    candidates.set(version, {
      version,
      prerelease: release.prerelease,
      install: feed ? 'in-app' : 'manual',
      installer,
      feed,
    })
    if (candidates.size === RECENT_VERSION_COUNT) break
  }
  return [...candidates.values()]
}

export async function fetchRecentVersions(
  channel: UpdateChannel,
  platform: VersionPlatform,
  token: string | null,
): Promise<VersionCandidate[]> {
  const response = await fetch(`${RELEASE_API}?per_page=100`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'tandem-office-updater',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    redirect: 'error',
    signal: AbortSignal.timeout(12_000),
  })
  if (!response.ok) throw new Error('Unable to load GitHub releases')
  return chooseRecentVersions(await response.json(), channel, platform)
}

export function versionAssetUrl(version: string, asset: ReleaseAsset, token: string | null): URL {
  return new URL(
    token
      ? `${RELEASE_API}/assets/${asset.id}`
      : `${GITHUB_RELEASES_URL}/download/v${version}/${asset.name}`,
  )
}

/** An explicit selection must match exactly one installer in that tag's feed. */
export function validatePinnedVersion(candidate: VersionCandidate, info: UpdateInfo) {
  const file = Array.isArray(info?.files) && info.files.length === 1 ? info.files[0] : undefined
  if (
    info?.version !== candidate.version ||
    file?.url !== candidate.installer.name ||
    typeof file.sha512 !== 'string' ||
    !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512)
  )
    throw new Error('The selected release does not match its installer feed')
  return file
}
