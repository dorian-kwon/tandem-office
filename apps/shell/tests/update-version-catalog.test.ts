import { describe, expect, it, vi } from 'vitest'
import { chooseRecentVersions, validatePinnedVersion } from '../src/main/update-version-catalog'
import { pinnedVersionProvider } from '../src/main/update-pinned-provider'

const target = { platform: 'win32', arch: 'x64', appImage: false } as const
const asset = (name: string, id: number, state = 'uploaded') => ({ name, id, state })
const release = (version: string, extra: Record<string, unknown> = {}) => ({
  tag_name: `v${version}`,
  draft: false,
  prerelease: false,
  published_at: '2026-11-19T03:00:00Z',
  assets: [asset('latest.yml', 101), asset(`tandem-office-Setup-${version}.exe`, 102)],
  ...extra,
})

describe('recent installable versions', () => {
  it('keeps the first five Windows releases with both complete assets on the stable channel', () => {
    const releases = [
      release('2.0.1', { draft: true }),
      release('2.0.0-beta.1', { prerelease: true }),
      release('1.9.0', { assets: [asset('latest.yml', 101)] }),
      release('1.8.0', {
        assets: [asset('latest.yml', 101), asset('tandem-office-Setup-1.8.0.exe', 102, 'new')],
      }),
      release('1.7.0'),
      release('1.7.0'),
      release('1.6.0'),
      release('1.5.0'),
      release('1.4.0'),
      release('1.3.0'),
      release('1.2.0'),
    ]
    expect(chooseRecentVersions(releases, 'stable', target).map(({ version }) => version)).toEqual([
      '1.7.0',
      '1.6.0',
      '1.5.0',
      '1.4.0',
      '1.3.0',
    ])
    expect(chooseRecentVersions(releases, 'beta', target)[0]?.version).toBe('2.0.0-beta.1')
  })

  it('matches the installed platform and uses its existing manual install path', () => {
    const releases = [
      release('1.7.0'),
      release('1.6.0', { assets: [asset('tandem-office-1.6.0-arm64.dmg', 202)] }),
      release('1.5.0', { assets: [asset('tandem-office-1.5.0-x64.dmg', 302)] }),
      release('1.4.0', { assets: [asset('tandem-office_1.4.0_amd64.deb', 402)] }),
    ]
    expect(
      chooseRecentVersions(releases, 'stable', { ...target, platform: 'darwin', arch: 'arm64' }),
    ).toMatchObject([{ version: '1.6.0', install: 'manual' }])
    expect(
      chooseRecentVersions(releases, 'stable', { ...target, platform: 'linux' }),
    ).toMatchObject([{ version: '1.4.0', install: 'manual' }])
    expect(
      chooseRecentVersions(releases, 'stable', { ...target, platform: 'linux', appImage: true }),
    ).toEqual([])
  })

  it('pins the feed to the selected tag and the exact installer hash and filename', () => {
    const [candidate] = chooseRecentVersions([release('1.5.0')], 'stable', target)
    const sha512 = Buffer.alloc(64, 25).toString('base64')
    const file = { url: 'tandem-office-Setup-1.5.0.exe', sha512, size: 100 }
    const info = { version: '1.5.0', files: [file], releaseDate: '2026-11-19' }
    expect(validatePinnedVersion(candidate!, info)).toEqual(file)
    expect(() => validatePinnedVersion(candidate!, { ...info, version: '1.7.0' })).toThrow()
    expect(() =>
      validatePinnedVersion(candidate!, {
        ...info,
        files: [{ ...file, url: 'https://other.example/installer.exe' }],
      }),
    ).toThrow()
    expect(() =>
      validatePinnedVersion(candidate!, { ...info, files: [{ ...file, sha512: '' }] }),
    ).toThrow()
  })
})

it('reads and resolves only the selected GitHub assets through the updater provider', async () => {
  const [candidate] = chooseRecentVersions([release('1.5.0')], 'stable', target)
  const sha512 = Buffer.alloc(64, 25).toString('base64')
  const request = vi.fn(
    async () => `version: 1.5.0
files:
  - url: tandem-office-Setup-1.5.0.exe
    sha512: ${sha512}
    size: 100
`,
  )
  const Provider = pinnedVersionProvider(candidate!, 'test-token')
  const provider = new Provider(undefined, {} as never, {
    platform: 'win32',
    isUseMultipleRangeRequest: true,
    executor: { request } as never,
  })
  const info = await provider.getLatestVersion()
  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({
      hostname: 'api.github.com',
      path: expect.stringMatching(/\/releases\/assets\/101$/),
      redirect: 'manual',
      headers: expect.objectContaining({
        accept: 'application/octet-stream',
        authorization: 'token test-token',
      }),
    }),
    undefined,
  )
  const [{ url, info: installer }] = provider.resolveFiles(info)
  expect(url.origin).toBe('https://api.github.com')
  expect(url.pathname).toMatch(/\/releases\/assets\/102$/)
  expect(installer.sha512).toBe(sha512)
  expect(provider.isUseMultipleRangeRequest).toBe(false)
})
