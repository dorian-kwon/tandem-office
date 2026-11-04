/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OcrImageLightbox } from '../src/renderer/src/translate/OcrImageLightbox'
import { LocaleProvider } from '../src/renderer/src/locale'

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let api: { ocrPreviewLarge: ReturnType<typeof vi.fn> }
let onClose: ReturnType<typeof vi.fn>

const items = [
  { index: 1, name: 'image1.jpg', location: 'Sheet1 · A7' },
  { index: 2, name: 'image2.jpg', location: 'Sheet1 · A82' },
  { index: 3, name: 'image3.jpg', location: 'Sheet1 · A157' },
]

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  api = {
    ocrPreviewLarge: vi.fn(async ({ index }: { index: number }) => ({
      data: new Uint8Array([index]),
      mime: 'image/jpeg',
    })),
  }
  onClose = vi.fn()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function open(start = 1) {
  await act(async () => {
    root.render(
      createElement(
        LocaleProvider,
        { initial: 'en' },
        createElement(OcrImageLightbox, {
          api: api as never,
          token: 'tok',
          items,
          start,
          onClose,
        }),
      ),
    )
  })
}
const key = async (k: string) =>
  act(async () => {
    host
      .querySelector('[data-lightbox]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  })
const click = async (el: Element) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
const shownIndex = () => host.querySelector('[data-lightbox]')!.getAttribute('data-index')

describe('OcrImageLightbox', () => {
  it('opens on the chosen picture, labelled with number, total and anchor cell, from the local large preview', async () => {
    await open(2)
    expect(shownIndex()).toBe('2')
    expect(host.textContent).toContain('Picture 2 of 3')
    expect(host.textContent).toContain('Sheet1 · A82')
    expect(api.ocrPreviewLarge).toHaveBeenCalledWith({ token: 'tok', index: 2 })
    expect(host.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/jpeg;base64,/)
  })

  it('moves with the arrow buttons and the Left/Right keys, stopping at the ends', async () => {
    await open(1)
    await click(host.querySelector('[data-action="next"]')!)
    expect(shownIndex()).toBe('2')
    await key('ArrowRight')
    expect(shownIndex()).toBe('3')
    await key('ArrowRight')
    expect(shownIndex()).toBe('3')
    expect((host.querySelector('[data-action="next"]') as HTMLButtonElement).disabled).toBe(true)
    await key('ArrowLeft')
    await click(host.querySelector('[data-action="prev"]')!)
    expect(shownIndex()).toBe('1')
    expect((host.querySelector('[data-action="prev"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('Esc closes the lightbox only and does not reach the dialog behind it', async () => {
    const behind = vi.fn()
    document.addEventListener('keydown', behind)
    await open(1)
    await key('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(behind).not.toHaveBeenCalled()
    document.removeEventListener('keydown', behind)
  })

  it('toggles between fit-to-width and actual size', async () => {
    await open(1)
    const view = host.querySelector('[data-lightbox-view]')!
    expect(view.getAttribute('data-zoom')).toBe('fit')
    await click(host.querySelector('[data-action="zoom"]')!)
    expect(view.getAttribute('data-zoom')).toBe('actual')
    await click(host.querySelector('[data-action="zoom"]')!)
    expect(view.getAttribute('data-zoom')).toBe('fit')
  })

  it('says plainly when no preview is available, and ignores a late answer for a picture already left', async () => {
    api.ocrPreviewLarge.mockImplementation(async ({ index }: { index: number }) =>
      index === 1 ? null : { data: new Uint8Array([index]), mime: 'image/jpeg' },
    )
    await open(1)
    expect(host.querySelector('[data-lightbox-empty]')).not.toBeNull()
    expect(host.querySelector('img')).toBeNull()
    await click(host.querySelector('[data-action="next"]')!)
    expect(host.querySelector('[data-lightbox-empty]')).toBeNull()
    expect(host.querySelector('img')).not.toBeNull()
  })

  it('the close button closes it', async () => {
    await open(1)
    await click(host.querySelector('[data-action="close"]')!)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
