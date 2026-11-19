import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOpenWikiService } from '../src/main/translate/open-wiki'

const release = 'https://github.com/obsidianmd/obsidian-releases/releases/download/v1.15.1/'
const officialPage = 'https://obsidian.md/download'
let temp: string
let vault: { vaultPath: string; indexPath: string }
const prepareVault = vi.fn(async () => vault)
const handlerName = vi.fn(async () => 'Obsidian')
const installed = vi.fn(async () => false)
const openExternal = vi.fn(async (_url: string) => {})
let timestamp: number
const request = vi.fn<typeof fetch>()
const registry = () => join(temp, 'obsidian', 'obsidian.json')
const registered = async (path: string) => {
  const config = JSON.stringify({ vaults: { someId: { path, open: true } } })
  await writeFile(registry(), config)
  return config
}

function service(options: Partial<Parameters<typeof createOpenWikiService>[0]> = {}) {
  return createOpenWikiService({
    userDataPath: temp,
    appDataPath: temp,
    handlerName,
    openExternal,
    prepareVault,
    installedWithoutHandler: installed,
    fetch: request,
    now: () => timestamp,
    platform: 'darwin',
    arch: 'arm64',
    ...options,
  })
}

beforeEach(async () => {
  vi.resetAllMocks()
  timestamp = Date.now()
  temp = await mkdtemp(join(tmpdir(), 'tandem-open-wiki-'))
  const vaultPath = join(temp, 'wiki #1 & 한글')
  vault = { vaultPath, indexPath: join(vaultPath, 'Index.md') }
  await Promise.all([mkdir(join(temp, 'obsidian')), mkdir(vaultPath)])
  handlerName.mockResolvedValue('Obsidian')
  prepareVault.mockImplementation(async () => vault)
  installed.mockResolvedValue(false)
  request.mockImplementation(async () =>
    Response.json({
      tag_name: 'v1.15.1',
      assets: ['.dmg', '.exe', '.AppImage', '-arm64.AppImage'].map((suffix) => ({
        name: 'Obsidian-1.15.1' + suffix,
      })),
    }),
  )
})
afterEach(async () => {
  await rm(temp, { recursive: true, force: true })
})

describe('opening the translation wiki', () => {
  it('opens the exact encoded start page and leaves Obsidian registration untouched', async () => {
    const content = await registered(vault.vaultPath)
    const ui = service()
    expect(await ui.openWiki()).toEqual({ status: 'opened', vaultPath: vault.vaultPath })
    expect(openExternal.mock.calls).toEqual([
      ['obsidian://open?path=' + encodeURIComponent(vault.indexPath)],
    ])
    expect(await readFile(registry(), 'utf8')).toBe(content)
    expect(request).not.toHaveBeenCalled()
    expect((await ui.resumeWiki()).status).toBe('idle')
  })

  it('does not match a same-name vault elsewhere; resumes once after the user registers the exact folder', async () => {
    const content = await registered(join(temp, 'elsewhere', 'wiki #1 & 한글'))
    const ui = service()
    expect((await ui.openWiki()).status).toBe('setup')
    expect(await readFile(registry(), 'utf8')).toBe(content)
    expect((await ui.resumeWiki()).status).toBe('idle')
    expect(await service().resumeWiki()).toMatchObject({ status: 'idle', pending: true })
    await registered(vault.vaultPath)
    const next = service()
    expect((await next.resumeWiki()).status).toBe('opened')
    expect((await next.resumeWiki()).status).toBe('idle')
    expect((await service().resumeWiki()).status).toBe('idle')
    expect(openExternal.mock.calls).toEqual([
      ['obsidian://choose-vault'],
      ['obsidian://open?path=' + encodeURIComponent(vault.indexPath)],
    ])
  })

  it('coalesces rapid finished clicks without delaying a newly registered vault', async () => {
    const ui = service()
    await ui.openWiki()
    await ui.openWiki()
    expect(openExternal).toHaveBeenCalledTimes(1)
    await registered(vault.vaultPath)
    await ui.openWiki()
    await ui.openWiki()
    expect(openExternal).toHaveBeenCalledTimes(2)
    timestamp += 2000
    await ui.openWiki()
    expect(openExternal).toHaveBeenCalledTimes(3)
  })

  it('compares Windows drive paths without regard to casing', async () => {
    handlerName.mockResolvedValue('Obsidian.exe')
    vault = { vaultPath: 'C:\\Users\\Test\\위키', indexPath: 'C:\\Users\\Test\\위키\\Index.md' }
    await registered('c:\\users\\test\\위키')
    expect((await service({ platform: 'win32' }).openWiki()).status).toBe('opened')
    expect(openExternal).toHaveBeenCalledWith(
      'obsidian://open?path=' + encodeURIComponent(vault.indexPath),
    )
  })

  it('continues a Windows download through first registration and opens the encoded note after restart', async () => {
    const dir = 'C:\\Users\\홍 길동\\AppData\\Roaming\\tandem office\\번역 #1 & 용어'
    vault = { vaultPath: dir, indexPath: dir + '\\index.md' }
    const executable = vi.fn(async () => '')
    const windows = () => service({ platform: 'win32', arch: 'x64', handlerExecutable: executable })
    handlerName.mockResolvedValue('')
    expect((await windows().openWiki()).status).toBe('download')
    handlerName.mockResolvedValue('URL: 옵시디언')
    executable.mockResolvedValue('C:\\Program Files\\Obsidian\\Obsidian.exe')
    expect((await windows().resumeWiki()).status).toBe('setup')
    await registered(dir.toLowerCase())
    expect((await windows().resumeWiki()).status).toBe('opened')
    expect((await windows().resumeWiki()).status).toBe('idle')
    const urls = openExternal.mock.calls.map(([url]) => url)
    expect(urls.slice(0, 2)).toEqual([release + 'Obsidian-1.15.1.exe', 'obsidian://choose-vault'])
    expect(new URL(urls[2]!).searchParams.get('path')).toBe(vault.indexPath)
    expect(urls).toHaveLength(3)
    executable.mockResolvedValue('C:\\Other\\Other.exe')
    expect((await windows().openWiki()).status).toBe('unavailable')
    expect(openExternal).toHaveBeenCalledTimes(3)
  })

  it('sets up a vault when the Obsidian config is temporarily unreadable', async () => {
    await writeFile(registry(), '{')
    expect((await service().openWiki()).status).toBe('setup')
    expect(await readFile(registry(), 'utf8')).toBe('{')
  })

  it.each([
    ['darwin', 'arm64', '.dmg'],
    ['darwin', 'x64', '.dmg'],
    ['win32', 'x64', '.exe'],
    ['win32', 'arm64', '.exe'],
    ['linux', 'x64', '.AppImage'],
    ['linux', 'arm64', '-arm64.AppImage'],
  ] as const)('uses the official installer for %s %s', async (platform, arch, suffix) => {
    handlerName.mockResolvedValue('')
    expect((await service({ platform, arch }).openWiki()).status).toBe('download')
    expect(openExternal.mock.calls).toEqual([[release + 'Obsidian-1.15.1' + suffix]])
  })

  it('falls back to the official page for offline or unsupported installer metadata', async () => {
    handlerName.mockResolvedValue('')
    request.mockRejectedValue(new Error('offline'))
    const ui = service()
    expect((await ui.openWiki()).status).toBe('download')
    expect((await ui.resumeWiki()).status).toBe('idle')
    expect((await ui.openWiki()).status).toBe('download')
    expect(openExternal.mock.calls).toEqual([[officialPage]])
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('does not download again on focus, restart or double click, then resumes after install', async () => {
    handlerName.mockResolvedValue('')
    const ui = service()
    await Promise.all([ui.openWiki(), ui.openWiki(), ui.resumeWiki()])
    const next = service()
    expect((await next.resumeWiki()).status).toBe('idle')
    expect((await next.openWiki()).status).toBe('download')
    expect(request).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledTimes(1)
    handlerName.mockResolvedValue('Obsidian')
    expect((await next.resumeWiki()).status).toBe('setup')
    expect((await next.resumeWiki()).status).toBe('idle')
    expect(openExternal).toHaveBeenCalledTimes(2)
  })

  it('allows an intentional retry after cancelling the installer in the browser', async () => {
    handlerName.mockResolvedValue('')
    const first = service()
    await first.openWiki()
    timestamp += 2000
    const next = service()
    expect((await next.resumeWiki()).status).toBe('idle')
    expect((await next.openWiki()).status).toBe('download')
    expect(openExternal).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['Obsidian', '.var/app/md.obsidian.Obsidian/config'],
    ['md.obsidian.Obsidian.desktop', '.var/app/md.obsidian.Obsidian/config'],
    ['obsidian_obsidian.desktop', 'snap/obsidian/current/.config'],
  ])('reads the Linux registry for %s in %s', async (handler, config) => {
    const folder = join(temp, config, 'obsidian')
    await mkdir(folder, { recursive: true })
    await writeFile(
      join(folder, 'obsidian.json'),
      JSON.stringify({ vaults: { id: { path: vault.vaultPath } } }),
    )
    handlerName.mockResolvedValue(handler)
    expect((await service({ platform: 'linux', homePath: temp }).openWiki()).status).toBe('opened')
  })

  it('lets an explicit click proceed during the idle startup probe', async () => {
    await registered(vault.vaultPath)
    const ui = service()
    const [resume, click] = await Promise.all([ui.resumeWiki(), ui.openWiki()])
    expect(resume.status).toBe('idle')
    expect(click.status).toBe('opened')
    expect(openExternal).toHaveBeenCalledTimes(1)
  })

  it('does not probe installations, create files or open URLs after a cancelled request expires', async () => {
    handlerName.mockResolvedValue('')
    await service().openWiki()
    timestamp += 25 * 60 * 60 * 1000
    vi.clearAllMocks()
    expect(await service().resumeWiki()).toEqual({ status: 'idle', vaultPath: '' })
    expect(handlerName).not.toHaveBeenCalled()
    expect(prepareVault).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('reports an installation missing its scheme or one claimed by another app', async () => {
    handlerName.mockResolvedValue('')
    installed.mockResolvedValue(true)
    expect((await service().openWiki()).status).toBe('unavailable')
    handlerName.mockResolvedValue('Other Obsidian App')
    expect((await service().openWiki()).status).toBe('unavailable')
    expect(request).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('does not launch an external application again on focus after the user refuses it', async () => {
    openExternal.mockRejectedValueOnce(new Error('refused'))
    expect((await service().openWiki()).status).toBe('unavailable')
    expect((await service().resumeWiki()).status).toBe('idle')
    expect(openExternal).toHaveBeenCalledTimes(1)
  })
})
