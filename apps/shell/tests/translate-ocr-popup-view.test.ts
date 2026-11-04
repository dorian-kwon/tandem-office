import { beforeEach, expect, it, vi } from 'vitest'

/**
 * Regression for the owner's report: opening the OCR popup used to switch the shell to the home
 * tab and a project detail screen and showed another window. The popup is now one overlay view
 * on the asking window: no BrowserWindow is constructed, the window's other views and tabs are
 * untouched, and closing removes exactly the overlay.
 */
const created = vi.hoisted(() => ({ windows: 0, views: [] as FakeView[] }))
interface FakeView {
  webContents: {
    id: number
    loaded: string[]
    closed: boolean
    handlers: Map<string, () => void>
    isDestroyed(): boolean
    once(event: string, fn: () => void): void
    setWindowOpenHandler(fn: unknown): void
    loadURL(url: string): Promise<void>
    focus(): void
    close(): void
  }
  setBackgroundColor(c: string): void
  setBounds(b: unknown): void
}
vi.mock('electron', () => ({
  BrowserWindow: class {
    constructor() {
      created.windows += 1
    }
  },
  WebContentsView: class {
    webContents = {
      id: 900 + created.views.length,
      loaded: [] as string[],
      closed: false,
      handlers: new Map<string, () => void>(),
      isDestroyed() {
        return this.closed
      },
      once(event: string, fn: () => void) {
        this.handlers.set(event, fn)
      },
      setWindowOpenHandler() {},
      loadURL(url: string) {
        this.loaded.push(url)
        return Promise.resolve()
      },
      focus() {},
      close() {
        this.closed = true
      },
    }
    setBackgroundColor() {}
    setBounds() {}
    constructor() {
      created.views.push(this as unknown as FakeView)
    }
  },
}))

import { mountOcrPopupView } from '../src/main/translate/ocr-popup-view'

function fakeWindow() {
  const children: unknown[] = []
  const events: string[] = []
  return {
    children,
    events,
    win: {
      isDestroyed: () => false,
      getContentSize: () => [1200, 800],
      on: (e: string) => void events.push(`on:${e}`),
      off: (e: string) => void events.push(`off:${e}`),
      contentView: {
        addChildView: (v: unknown) => {
          const at = children.indexOf(v)
          if (at >= 0) children.splice(at, 1)
          children.push(v)
        },
        removeChildView: (v: unknown) => {
          const at = children.indexOf(v)
          if (at >= 0) children.splice(at, 1)
        },
      },
    },
  }
}

beforeEach(() => {
  created.windows = 0
  created.views.length = 0
})

it('mounts one overlay view on the asking window and creates no window', () => {
  const { win, children } = fakeWindow()
  const tabView = { tab: true }
  children.push(tabView)
  const handle = mountOcrPopupView({
    window: win as never,
    target: { dir: '/work/p', file: 'a.xlsx' },
    preloadPath: '/preload.js',
    onGone: () => undefined,
  })
  expect(created.windows).toBe(0)
  expect(created.views).toHaveLength(1)
  // the editor's own view is still there, the overlay sits above it
  expect(children).toEqual([tabView, created.views[0]])
  expect(handle.popupId).toBe(created.views[0]?.webContents.id)
  // it shows the popup mode of the app bundle, with the project and source it was asked for
  const url = new URL(created.views[0]!.webContents.loaded[0]!)
  expect(url.searchParams.get('mode')).toBe('ocr-popup')
  expect(url.searchParams.get('file')).toBe('a.xlsx')
})

it('closing removes exactly the overlay and leaves the other views in place', () => {
  const { win, children, events } = fakeWindow()
  const tabView = { tab: true }
  children.push(tabView)
  const handle = mountOcrPopupView({
    window: win as never,
    target: { dir: '/d', file: 'a.xlsx' },
    preloadPath: '/p.js',
    onGone: () => undefined,
  })
  handle.destroy()
  expect(children).toEqual([tabView])
  expect(created.views[0]?.webContents.closed).toBe(true)
  expect(events).toContain('off:resize')
  // a second destroy is harmless
  handle.destroy()
  expect(created.windows).toBe(0)
})

it('reports an overlay that went away by itself, but not one main removed', () => {
  const { win } = fakeWindow()
  const gone: number[] = []
  const handle = mountOcrPopupView({
    window: win as never,
    target: { dir: '/d', file: 'a.xlsx' },
    preloadPath: '/p.js',
    onGone: (id) => gone.push(id),
  })
  created.views[0]?.webContents.handlers.get('destroyed')?.()
  expect(gone).toEqual([handle.popupId])
})
