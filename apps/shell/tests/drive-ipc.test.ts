import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { registerDriveIpc } from '../src/main/drive/drive-ipc'
import { DRIVE_CHANNELS } from '../src/shared/drive-api'

const { handlers, decrypt, available, fetch } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  decrypt: vi.fn(() => 'test-refresh-token'),
  available: vi.fn(() => true),
  fetch: vi.fn(async (url: string) =>
    Response.json(
      url.includes('oauth2') ? { access_token: 'test-access', expires_in: 3600 } : { files: [] },
    ),
  ),
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
  },
  safeStorage: { isEncryptionAvailable: available, decryptString: decrypt },
  net: { fetch },
  webContents: { getAllWebContents: () => [] },
}))
vi.mock('@genoffice/electron-utils', () => ({ safeExternalUrl: (url: string) => url }))

it('restores a saved Mac Drive token only on real Drive use, once across concurrent requests', async () => {
  vi.stubGlobal('__GENOFFICE_GOOGLE_CLIENT_ID__', 'example.apps.googleusercontent.com')
  vi.stubGlobal('__GENOFFICE_GOOGLE_CLIENT_SECRET__', 'test-secret')
  const folder = await mkdtemp(join(tmpdir(), 'drive-on-demand-'))
  const settings = join(folder, 'app-settings.json')
  await writeFile(settings, JSON.stringify({ driveTrainingAck: true }))
  await writeFile(
    join(folder, 'google-drive.json'),
    JSON.stringify({ version: 1, token: 'dGVzdA==' }),
  )
  const service = registerDriveIpc(
    {
      userData: () => folder,
      settingsPath: () => settings,
      lang: () => 'en',
      window: () => null,
      openPath: () => true,
      isOpen: () => false,
      parse: async () => ({ ok: true }),
      freeAi: () => false,
      documentOf: () => null,
    },
    'darwin',
  )
  try {
    const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!(null, ...args)
    expect(await call(DRIVE_CHANNELS.state)).toMatchObject({ state: 'connected' })
    expect(await call(DRIVE_CHANNELS.connected)).toBe(true)
    expect(await call(DRIVE_CHANNELS.aiEnabled)).toBe(true)
    expect(service.reopen(join(folder, 'local.docx'))).toBeNull()
    // Wait for the local Drive index and watcher to finish starting as well.
    expect(await service.reopen(join(folder, 'drive-cache', 'untracked.docx'))).toBe(true)
    expect(available).not.toHaveBeenCalled()
    expect(decrypt).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()

    const list = () => call(DRIVE_CHANNELS.list, { kind: 'recent' })
    expect(await Promise.all([list(), list()])).toEqual([
      { ok: true, files: [] },
      { ok: true, files: [] },
    ])
    expect(available).toHaveBeenCalledTimes(1)
    expect(decrypt).toHaveBeenCalledTimes(1)
  } finally {
    service.stop()
    vi.unstubAllGlobals()
    await rm(folder, { recursive: true, force: true })
  }
})
