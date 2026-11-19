/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LocaleProvider } from '../src/renderer/src/locale'
import {
  TranslationWikiButton,
  TranslationWikiProvider,
} from '../src/renderer/src/translate/TranslationWiki'
import type { TranslationWikiOpenResult } from '../src/shared/translate-api'

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
env.IS_REACT_ACT_ENVIRONMENT = true
const vaultPath = '/우리 위키/기관 & 문체'
const result = (status: TranslationWikiOpenResult['status']) => ({ status, vaultPath })
const openWiki = vi.fn<() => Promise<TranslationWikiOpenResult>>()
const resumeWiki = vi.fn<() => Promise<TranslationWikiOpenResult>>()
const copyText = vi.fn()
const activate = vi.fn()

let root: Root
let host: HTMLDivElement
async function render(homeActive = true) {
  await act(async () =>
    root.render(
      createElement(LocaleProvider, {
        initial: 'en',
        children: createElement(TranslationWikiProvider, {
          homeActive,
          children: createElement(TranslationWikiButton),
        }),
      }),
    ),
  )
}
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === label)
  expect(button).toBeDefined()
  await act(async () => button!.click())
}
const focus = () =>
  act(async () => {
    window.dispatchEvent(new Event('focus'))
  })

beforeEach(() => {
  vi.resetAllMocks()
  openWiki.mockResolvedValue(result('opened'))
  resumeWiki.mockResolvedValue(result('idle'))
  copyText.mockResolvedValue(undefined)
  activate.mockResolvedValue(undefined)
  vi.stubGlobal('translateApi', { openWiki, resumeWiki })
  vi.stubGlobal('aiOfficeIntegrations', { copyText })
  vi.stubGlobal('aiOfficeTabs', { activate })
  // jsdom does not implement the browser's native dialog methods.
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value() {
        this.open = true
      },
    },
    close: {
      configurable: true,
      value() {
        this.open = false
      },
    },
  })
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close')
  vi.unstubAllGlobals()
})

it('skips focus IPC after confirming there is no pending request', async () => {
  await render()
  expect(resumeWiki).toHaveBeenCalledTimes(1)
  await focus()
  await focus()
  expect(resumeWiki).toHaveBeenCalledTimes(1)
})

it('keeps a pending installation across restart until it can resume', async () => {
  resumeWiki.mockResolvedValue({ ...result('idle'), pending: true })
  await render()
  await focus()
  expect(resumeWiki).toHaveBeenCalledTimes(2)
  resumeWiki.mockResolvedValue(result('opened'))
  await focus()
  await focus()
  expect(resumeWiki).toHaveBeenCalledTimes(3)
  expect(openWiki).not.toHaveBeenCalled()
})

it('opens a connected wiki from the editor strip without moving the user to Home', async () => {
  await render(false)
  await click('View wiki')
  expect(openWiki).toHaveBeenCalledTimes(1)
  expect(activate).not.toHaveBeenCalled()
  expect(host.querySelector('dialog')).toBeNull()
  resumeWiki.mockClear()
  await focus()
  expect(resumeWiki).not.toHaveBeenCalled()
})

it('brings first-time setup into view and copies the exact vault path', async () => {
  openWiki.mockResolvedValue(result('setup'))
  await render(false)
  await click('View wiki')
  expect(activate).toHaveBeenCalledWith('home')
  await render(true)
  expect(host.querySelector('dialog')?.open).toBe(true)
  expect(host.querySelector('input')?.value).toBe(vaultPath)
  await click('Copy path')
  expect(copyText).toHaveBeenCalledWith(vaultPath)
  expect(host.textContent).toContain('Copied')
  await click('Dismiss')
  expect(host.querySelector('dialog')).toBeNull()
})

it('resumes after installation on focus without requesting another download', async () => {
  openWiki.mockResolvedValue(result('download'))
  await render()
  await click('View wiki')
  expect(host.textContent).toContain('Finish installing Obsidian')
  resumeWiki.mockClear().mockResolvedValue(result('opened'))
  await focus()
  await focus()
  expect(resumeWiki).toHaveBeenCalledTimes(1)
  expect(openWiki).toHaveBeenCalledTimes(1)
  expect(host.querySelector('dialog')).toBeNull()
})

it('restores pending setup on launch, and leaves the path selectable if copying fails', async () => {
  resumeWiki.mockResolvedValue(result('setup'))
  copyText.mockRejectedValue(new Error('clipboard unavailable'))
  await render()
  expect(host.textContent).toContain('Open folder as vault')
  expect(openWiki).not.toHaveBeenCalled()
  await click('Copy path')
  const field = host.querySelector('input')!
  expect(document.activeElement).toBe(field)
  expect(field.selectionEnd).toBe(vaultPath.length)
  expect(host.textContent).not.toContain('Copied')
})

it('coalesces rapid clicks and shows a localized launch error', async () => {
  let fail!: (e: Error) => void
  openWiki.mockReturnValue(
    new Promise((_, reject) => {
      fail = reject
    }),
  )
  await render()
  const button = host.querySelector('button')!
  await act(async () => {
    button.click()
    button.click()
  })
  expect(openWiki).toHaveBeenCalledTimes(1)
  await act(async () => fail(new Error('platform-specific detail')))
  expect(host.textContent).toContain('The wiki could not be opened')
  expect(host.textContent).not.toContain('platform-specific detail')
})
