import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * What a crash line says besides the basics (how long the app ran, which tabs were open, the
 * last actions) and the report of an error thrown inside a page, which used to leave no trace.
 */

const userData = mkdtempSync(join(tmpdir(), 'crash-watch-detail-'))
const { fakeApp, existing } = vi.hoisted(() => ({
  fakeApp: {} as EventEmitter & {
    getPath: (name: string) => string
    getAppMetrics: () => Array<{ memory: { workingSetSize: number } }>
  },
  existing: [] as unknown[],
}))

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  Object.setPrototypeOf(fakeApp, Emitter.prototype)
  Emitter.call(fakeApp)
  fakeApp.getPath = () => userData
  fakeApp.getAppMetrics = () => []
  return {
    app: fakeApp,
    dialog: { showMessageBox: vi.fn(async () => ({ response: 1, checkboxChecked: false })) },
    webContents: { getAllWebContents: () => existing },
  }
})

vi.mock('../src/main/renderer-disposal', () => ({ wasReleasedRenderer: () => false }))

import { noteActivity } from '../src/main/activity-trail'
import { startCrashWatch, startRendererErrorWatch } from '../src/main/crash-watch'
import { RENDERER_ERROR_HOOK, RENDERER_ERROR_TAG } from '../src/main/renderer-errors'

startCrashWatch({
  memory: () => ({}),
  prompt: false,
  editorOf: () => 'docs',
  documentOf: () => null,
  parentWindow: () => null,
  closeDocument: () => true,
  reopen: () => {},
  tabs: () => ({ docs: 2, sheets: 1 }),
  t: (key) => key,
})

const logFile = join(userData, 'crash-log.jsonl')
const lines = (): Array<Record<string, unknown>> =>
  existsSync(logFile)
    ? readFileSync(logFile, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : []

function fakeContents(options: { url?: string; loading?: boolean } = {}) {
  const wc = new EventEmitter() as EventEmitter & {
    id: number
    isDestroyed: () => boolean
    getURL: () => string
    getType: () => string
    isLoading: () => boolean
    executeJavaScript: ReturnType<typeof vi.fn>
  }
  wc.id = 5
  wc.isDestroyed = () => false
  wc.getURL = () => options.url ?? 'file:///app/index.html'
  wc.getType = () => 'window'
  wc.isLoading = () => options.loading ?? false
  wc.executeJavaScript = vi.fn(async () => undefined)
  return wc
}

beforeEach(() => {
  rmSync(logFile, { force: true })
  existing.length = 0
  // each test starts its own watch; the app starts one
  fakeApp.removeAllListeners('web-contents-created')
})

afterAll(() => rmSync(userData, { recursive: true, force: true }))

describe('crash line detail', () => {
  it('carries how long the app ran, the open tabs and the last actions', () => {
    noteActivity('tab-open:docs')
    noteActivity('ai-start')
    fakeApp.emit('child-process-gone', {}, { reason: 'crashed', exitCode: 1, type: 'GPU' })
    const [line] = lines()
    expect(line).toMatchObject({ kind: 'child-process', tabs: { docs: 2, sheets: 1 } })
    expect(typeof line?.uptimeS).toBe('number')
    const trail = line?.trail as Array<{ t: number; a: string }>
    expect(trail.map((item) => item.a).slice(-2)).toEqual(['tab-open:docs', 'ai-start'])
  })
})

describe('startRendererErrorWatch', () => {
  const taggedError = (): string =>
    RENDERER_ERROR_TAG +
    JSON.stringify({
      n: 'Error',
      m: 'Minified React error #185; visit https://react.dev/errors/185',
      s: 'Error: x\n    at Ke (file:///C:/Users/me/resources/modules/docs/assets/index-Dk3f9a.js:12:3456)',
    })

  it('puts the reporting script in a page once it is ready', () => {
    startRendererErrorWatch({ editorOf: () => 'docs' })
    const wc = fakeContents()
    fakeApp.emit('web-contents-created', {}, wc)
    expect(wc.executeJavaScript).not.toHaveBeenCalled()
    wc.emit('dom-ready')
    expect(wc.executeJavaScript).toHaveBeenCalledWith(RENDERER_ERROR_HOOK)
  })

  it('writes a tagged console report as a renderer-error line with the editor', () => {
    startRendererErrorWatch({ editorOf: () => 'sheets' })
    const wc = fakeContents()
    fakeApp.emit('web-contents-created', {}, wc)
    wc.emit('console-message', { message: taggedError(), level: 'error' })
    expect(lines()).toEqual([
      expect.objectContaining({
        kind: 'renderer-error',
        reason: 'Error',
        editor: 'sheets',
        code: '185',
        frames: ['Ke@index-Dk3f9a.js:12:3456'],
      }),
    ])
    expect(readFileSync(logFile, 'utf8')).not.toMatch(/Users|visit|react\.dev/)
  })

  it('ignores every other console message', () => {
    startRendererErrorWatch({ editorOf: () => 'docs' })
    const wc = fakeContents()
    fakeApp.emit('web-contents-created', {}, wc)
    wc.emit('console-message', {
      message: 'Uncaught Error: Minified React error #185',
      level: 'error',
    })
    wc.emit('console-message', { message: 'hello', level: 'info' })
    expect(lines()).toEqual([])
  })

  it('writes a repeated error once, so a render loop cannot fill the log', () => {
    startRendererErrorWatch({ editorOf: () => 'docs' })
    const wc = fakeContents()
    fakeApp.emit('web-contents-created', {}, wc)
    for (let i = 0; i < 50; i++)
      wc.emit('console-message', { message: taggedError(), level: 'error' })
    expect(lines()).toHaveLength(1)
  })

  it('leaves the developer tools alone', () => {
    startRendererErrorWatch({ editorOf: () => 'docs' })
    const wc = fakeContents({ url: 'devtools://devtools/bundled/inspector.html' })
    fakeApp.emit('web-contents-created', {}, wc)
    wc.emit('dom-ready')
    expect(wc.executeJavaScript).not.toHaveBeenCalled()
  })

  it('also covers a page that was already open when the watch started', () => {
    const open = fakeContents()
    existing.push(open)
    startRendererErrorWatch({ editorOf: () => 'home' })
    expect(open.executeJavaScript).toHaveBeenCalledWith(RENDERER_ERROR_HOOK)
  })

  it('also covers a page that is past dom-ready but still loading when the watch starts', () => {
    // the shell's first page is in this state at startup: dom-ready has fired, loading goes on
    const loading = fakeContents({ loading: true })
    existing.push(loading)
    startRendererErrorWatch({ editorOf: () => 'home' })
    expect(loading.executeJavaScript).toHaveBeenCalledWith(RENDERER_ERROR_HOOK)
  })

  it('does not fail when a page refuses the script', async () => {
    startRendererErrorWatch({ editorOf: () => 'docs' })
    const wc = fakeContents()
    wc.executeJavaScript = vi.fn(async () => {
      throw new Error('Object has been destroyed')
    })
    fakeApp.emit('web-contents-created', {}, wc)
    wc.emit('dom-ready')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(lines()).toEqual([])
  })
})
