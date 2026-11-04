/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LocaleProvider } from '../src/renderer/src/locale'

vi.mock('../src/renderer/src/subscription-client', () => ({
  useSubscriptionConnection: () => ({
    statuses: { 'claude-code': { state: 'ready' } },
    busy: false,
    failed: {},
  }),
}))
vi.mock('../src/renderer/src/FirstConnectionNotice', () => ({
  useFirstConnectionNotice: () => ({
    settings: { provider: 'auto', providers: {}, subscriptionNoticeSeen: true },
    due: false,
    acknowledge: () => undefined,
  }),
  FirstConnectionDialog: () => null,
}))

import { OcrPopupScreen } from '../src/renderer/src/translate/OcrPopupScreen'

/**
 * The popup overlay's own root: one dialog for the asked source, nothing of the shell around it
 * (no project list, no detail screen), and every way out tells main through the popup channels.
 */
const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
env.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let api: Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  api = {
    getProject: vi.fn().mockResolvedValue({
      sources: [{ file: 'a.xlsx', sha256: 'x', kind: 'editable' }],
    }),
    ocrPrepare: vi.fn().mockResolvedValue({
      token: 't',
      kind: 'embedded',
      ocr: { kind: 'ai', provider: 'claude' },
      items: [{ index: 1, name: 'a.png', location: 'S · A7' }],
    }),
    ocrRelease: vi.fn().mockResolvedValue(undefined),
    ocrPreview: vi.fn().mockResolvedValue(null),
    ocrPopupClosed: vi.fn().mockResolvedValue(undefined),
    ocrPopupResult: vi.fn().mockResolvedValue(undefined),
  }
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function render(file = 'a.xlsx') {
  await act(async () => {
    root.render(
      createElement(
        LocaleProvider,
        { initial: 'en' },
        createElement(OcrPopupScreen, { dir: '/work/p', file, api: api as never }),
      ),
    )
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!

it('shows only the selection dialog for the asked source: no project list or detail screen', async () => {
  await render()
  expect(host.querySelector('.translate-ocr')).not.toBeNull()
  expect(api.getProject).toHaveBeenCalledWith('/work/p')
  expect(api.ocrPrepare).toHaveBeenCalledWith({ dir: '/work/p', files: ['a.xlsx'] })
  expect(host.querySelector('[data-action="embedded-ocr"]')).toBeNull()
  expect(host.querySelector('[role="table"]')).toBeNull()
})

it('Cancel tells main the popup closed and sends nothing', async () => {
  await render()
  await act(async () => {
    button('Cancel').dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  expect(api.ocrPopupClosed).toHaveBeenCalledTimes(1)
  expect(api.ocrPopupResult).not.toHaveBeenCalled()
})

it('a source the project does not have closes the popup at once', async () => {
  await render('other.xlsx')
  expect(host.querySelector('.translate-ocr')).toBeNull()
  expect(api.ocrPopupClosed).toHaveBeenCalledTimes(1)
})
