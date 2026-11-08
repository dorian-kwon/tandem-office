/**
 * Main-process side of the AI compare popup: the ego lite driver behind IPC, the
 * reader of a translation project's Korean original, and the stored consent.
 * Registered once per process from registerAiIpc. Nothing here runs unless the
 * person pressed the popup's button; it never reads cookies or logins, and the
 * ego lite installer is never downloaded or run by the app (see docs/security.md,
 * "Web AI comparison").
 */
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import { killProcessTree } from '@genoffice/ai-provider/subscription'
import { COMPARE_CHANNELS, type CompareAnswer, type CompareDriver } from '../../shared/compare'
import { compareSiteById } from '../../shared/compare-sites'
import { detectEgo } from './ego-detect'
import { createEgoDriver, egoChildEnv, type EgoChild } from './ego-driver'
import { readCompareConsent, writeCompareConsent } from './consent-store'
import { COMPARE_SOURCE_MAX_BYTES, translationSourceCopy } from './source-path'

const PROMPT_MAX_CHARS = 60_000
const ID_MAX_CHARS = 80

const exists = (path: string): Promise<boolean> =>
  access(path, constants.F_OK).then(
    () => true,
    () => false,
  )

/** `<program> --version` through execFile: no shell, allow-listed environment, short timeout */
function runsVersion(program: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile(
        program,
        ['--version'],
        {
          env: egoChildEnv(process.env, process.platform),
          timeout: 5_000,
          windowsHide: true,
          shell: false,
        },
        (error) => resolve(!error),
      )
    } catch {
      resolve(false)
    }
  })
}

const children = new Set<EgoChild>()

export function createRealCompareDriver(): CompareDriver {
  const detect = (): ReturnType<CompareDriver['detect']> =>
    detectEgo({
      platform: process.platform,
      env: process.env,
      homeDir: homedir(),
      exists,
      runsVersion,
    })
  return createEgoDriver({
    detect,
    platform: process.platform,
    env: process.env,
    nonce: () => randomUUID().replace(/-/g, ''),
    spawn: (command, args, env) => {
      const child = spawn(command, args, {
        env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        // its own process group on POSIX, so the whole tree can be ended
        detached: process.platform !== 'win32',
      }) as unknown as EgoChild
      children.add(child)
      child.on('close', () => children.delete(child))
      return child
    },
    killTree: (child) => killProcessTree(child, { force: true }),
  })
}

export interface CompareIpcDeps {
  /** the file path of the document a window shows (docs-main keeps it per renderer) */
  openPathOf(webContentsId: number): string | undefined
  /** the driver; the real one unless a test passes another */
  driver?: CompareDriver
}

let registered = false

export function registerCompareIpc(deps: CompareIpcDeps): void {
  if (registered) return
  registered = true
  const driver = deps.driver ?? createRealCompareDriver()
  const consentFile = (): string => join(app.getPath('userData'), 'web-compare.json')
  const consentFs = {
    read: () => readFile(consentFile(), 'utf8').catch(() => null),
    write: (text: string) => writeFile(consentFile(), text, 'utf8'),
  }
  const runs = new Map<string, AbortController>()

  // every program this feature started ends with the app
  app.once('before-quit', () => {
    for (const run of runs.values()) run.abort()
    for (const child of children) killProcessTree(child, { force: true })
  })

  ipcMain.handle(COMPARE_CHANNELS.detect, () => driver.detect())

  ipcMain.handle(COMPARE_CHANNELS.ask, async (event, request: unknown): Promise<CompareAnswer> => {
    const { id, siteId, prompt } = (request ?? {}) as Record<string, unknown>
    const site = typeof siteId === 'string' ? compareSiteById(siteId) : undefined
    if (
      typeof id !== 'string' ||
      id === '' ||
      id.length > ID_MAX_CHARS ||
      !site ||
      typeof prompt !== 'string' ||
      prompt.trim() === '' ||
      prompt.length > PROMPT_MAX_CHARS
    ) {
      return { ok: false, reason: 'invalid request' }
    }
    const key = `${event.sender.id}:${id}`
    runs.get(key)?.abort()
    const controller = new AbortController()
    runs.set(key, controller)
    const onGone = (): void => controller.abort()
    event.sender.once('destroyed', onGone)
    try {
      return await driver.ask(site, prompt, controller.signal)
    } catch (error) {
      return { ok: false, reason: String(error).slice(0, 200) }
    } finally {
      event.sender.removeListener('destroyed', onGone)
      if (runs.get(key) === controller) runs.delete(key)
    }
  })

  ipcMain.handle(COMPARE_CHANNELS.cancel, (event, id: unknown) => {
    if (typeof id !== 'string') return
    runs.get(`${event.sender.id}:${id}`)?.abort()
  })

  ipcMain.handle(COMPARE_CHANNELS.readSource, async (event) => {
    try {
      const outputPath = deps.openPathOf(event.sender.id)
      if (!outputPath) return { ok: false }
      const source = await translationSourceCopy(outputPath, process.platform, exists)
      if (!source) return { ok: false }
      if ((await stat(source)).size > COMPARE_SOURCE_MAX_BYTES) return { ok: false }
      return { ok: true, bytes: new Uint8Array(await readFile(source)) }
    } catch {
      return { ok: false }
    }
  })

  ipcMain.handle(COMPARE_CHANNELS.getConsent, () => readCompareConsent(consentFs))
  ipcMain.handle(COMPARE_CHANNELS.setConsent, async () => {
    await writeCompareConsent(consentFs)
    return true
  })
}
