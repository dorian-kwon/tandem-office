import type { BrowserWindow } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LANGS } from '@genoffice/i18n'
import { IMAGE_COPY_STRINGS, imageCopyText } from '../src/main/document-images/strings'
import { createImageCopyProgress } from '../src/main/document-images/progress-window'

interface ProbeWindow {
  options: Record<string, unknown>
  close(): void
  loadURL: ReturnType<typeof vi.fn>
  webContents: {
    emit(event: string): boolean
    executeJavaScript: ReturnType<typeof vi.fn>
  }
}
const fake = vi.hoisted(() => ({ windows: [] as ProbeWindow[] }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    BrowserWindow: class extends EventEmitter {
      destroyed = false
      webContents = Object.assign(new EventEmitter(), {
        isDestroyed: () => this.destroyed,
        executeJavaScript: vi.fn(async () => {}),
        setWindowOpenHandler: vi.fn(),
      })
      loadURL = vi.fn(async (_url: string) => {})
      removeMenu = vi.fn()
      show = vi.fn()
      constructor(public options: Record<string, unknown>) {
        super()
        fake.windows.push(this)
      }
      isDestroyed() {
        return this.destroyed
      }
      close() {
        if (this.destroyed) return
        this.destroyed = true
        this.emit('closed')
      }
    },
  }
})

describe('document image copy translations', () => {
  const keys = Object.keys(IMAGE_COPY_STRINGS.zh) as Array<keyof typeof IMAGE_COPY_STRINGS.zh>
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
  it.each(LANGS)('%s has every key and the same placeholders', (lang) => {
    expect(Object.keys(IMAGE_COPY_STRINGS[lang]).sort()).toEqual([...keys].sort())
    for (const key of keys) {
      const text = IMAGE_COPY_STRINGS[lang][key]
      expect(text.trim().length).toBeGreaterThan(0)
      expect(placeholders(text), `${lang}.${key}`).toEqual(placeholders(IMAGE_COPY_STRINGS.en[key]))
    }
    if (lang !== 'en') {
      expect(IMAGE_COPY_STRINGS[lang].title).not.toBe(IMAGE_COPY_STRINGS.en.title)
      expect(IMAGE_COPY_STRINGS[lang].detail).not.toBe(IMAGE_COPY_STRINGS.en.detail)
    }
  })
  it('formats the measured result and distinguishes keeping the original from making a copy', () => {
    expect(imageCopyText('en', 'result', { before: 690, after: 14, count: 38, skipped: 7 })).toBe(
      '690 MB → 14 MB; converted 38, unchanged 7',
    )
    expect(imageCopyText('ko', 'keepOriginal')).toBe('원본 열기')
    expect(imageCopyText('ko', 'makeCopy')).toBe('JPEG 사본 만들기')
    expect(imageCopyText('ko', 'detail')).toContain('손실 압축')
  })
})

describe('document image copy progress window', () => {
  beforeEach(() => {
    fake.windows.length = 0
  })

  it('isolates its trusted page, uses RTL and queues text updates until loaded', () => {
    const parent = { isDestroyed: () => false } as unknown as BrowserWindow
    const progress = createImageCopyProgress(parent, 'ar', vi.fn())
    const window = fake.windows[0]
    expect(window.options).toMatchObject({
      parent,
      modal: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    const html = decodeURIComponent(String(window.loadURL.mock.calls[0][0]).split(',')[1])
    expect(html).toContain('lang="ar-SA" dir="rtl"')
    expect(html).toContain("default-src 'none'")
    const nonce = html.match(/script-src 'nonce-([^']+)'/)?.[1]
    expect(nonce).toBeTruthy()
    expect(html).toContain(`<script nonce="${nonce}">`)
    expect(html).toContain(`<style nonce="${nonce}">`)
    expect(html).not.toContain('unsafe-inline')
    expect(html).toContain("addEventListener('click', () => window.close())")
    progress.update(2, 10)
    expect(window.webContents.executeJavaScript).not.toHaveBeenCalled()
    window.webContents.emit('did-finish-load')
    const script = String(window.webContents.executeJavaScript.mock.calls[0][0])
    expect(script).toContain('.textContent = "2/10"')
    expect(script).toContain('bar.max = 10')
    expect(script).not.toContain('innerHTML')
    progress.close()
  })

  it('cancels once when the user closes the window, and ignores later progress', () => {
    const cancel = vi.fn()
    const progress = createImageCopyProgress(null, 'en', cancel)
    const window = fake.windows[0]
    window.webContents.emit('did-finish-load')
    window.close()
    progress.update(1, 5)
    progress.close()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(window.webContents.executeJavaScript).not.toHaveBeenCalled()
  })

  it('does not cancel when the worker closes the window and bounds invalid counts', () => {
    const cancel = vi.fn()
    const progress = createImageCopyProgress(null, 'en', cancel)
    const window = fake.windows[0]
    window.webContents.emit('did-finish-load')
    progress.update(Number.NaN, Number.POSITIVE_INFINITY)
    expect(window.webContents.executeJavaScript.mock.calls[0][0]).toContain('.textContent = "0/0"')
    progress.close()
    expect(cancel).not.toHaveBeenCalled()
  })
})
