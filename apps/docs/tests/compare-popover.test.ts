// The AI compare popup in a real tiptap editor with a fake main process: the install
// question when ego lite is missing, the one-time consent, the per-engine flow, the
// replacement ("use this") and closing with Escape. No network, no real program.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Editor } from '@tiptap/core'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { LocaleProvider } from '../src/renderer/i18n/locale'
import { AiComparePopover } from '../src/renderer/components/AiComparePopover'
import { snapshotSelection } from '../src/renderer/compare/replace-selection'
import { AI_PROVIDERS, type AiSettings } from '../src/shared/ipc'
import { EGO_INSTALL_URL } from '../src/shared/compare-sites'

const settings: AiSettings = {
  provider: 'anthropic',
  providers: Object.fromEntries(
    AI_PROVIDERS.map((p) => [p.id, { apiKey: '', model: p.defaultModel }]),
  ) as AiSettings['providers'],
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  vi.restoreAllMocks()
  delete (window as unknown as { desktop?: unknown }).desktop
})
beforeAll(() => {
  Element.prototype.scrollTo ??= () => {}
})

function setup(desktop: Record<string, unknown>) {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: {
      type: 'doc',
      content: [
        {
          type: 'docParagraph',
          attrs: { docxIndex: null },
          content: [{ type: 'text', text: 'Revenue grew eight percent.' }],
        },
      ],
    } as never,
  })
  editor.commands.setTextSelection({ from: 14, to: 27 })
  const snapshot = snapshotSelection(editor)!
  ;(window as unknown as { desktop: unknown }).desktop = {
    onLanguageChanged: () => () => {},
    ...desktop,
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  const onClose = vi.fn()
  act(() =>
    root.render(
      createElement(
        LocaleProvider,
        { initial: 'en', children: null },
        createElement(AiComparePopover, {
          editor,
          snapshot,
          settings,
          trackChanges: false,
          onClose,
        }),
      ),
    ),
  )
  cleanups.push(() => {
    act(() => root.unmount())
    container.remove()
    editor.destroy()
  })
  return { editor, container, onClose }
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
const button = (c: HTMLElement, label: string): HTMLButtonElement | undefined =>
  [...c.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)

describe('AI compare popup', () => {
  it('asks to install ego lite when it is missing, opens the install page only on request and offers a re-check', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const detect = vi
      .fn()
      .mockResolvedValueOnce({ installed: false })
      .mockResolvedValueOnce({ installed: true, path: '/x' })
    const { container } = setup({
      compareDetect: detect,
      compareGetConsent: async () => true,
      compareSetConsent: async () => true,
    })
    await flush()
    expect(container.textContent).toContain('The ego browser is not installed. Install it?')
    expect(open).not.toHaveBeenCalled()
    // the comparison cannot start while it is missing
    expect(button(container, 'Compare')).toBeUndefined()
    act(() => button(container, 'Install')!.click())
    expect(open).toHaveBeenCalledWith(EGO_INSTALL_URL)
    expect(container.textContent).toContain('never downloads or runs the installer')
    act(() => button(container, 'Check again')!.click())
    await flush()
    expect(detect).toHaveBeenCalledTimes(2)
    expect(button(container, 'Compare')).toBeDefined()
  })

  it('shows consent first, remembers it, and sends nothing before then', async () => {
    const setConsent = vi.fn(async () => true)
    const ask = vi.fn()
    const { container } = setup({
      compareDetect: async () => ({ installed: true, path: '/x' }),
      compareGetConsent: async () => false,
      compareSetConsent: setConsent,
      compareAsk: ask,
    })
    await flush()
    expect(container.textContent).toContain('Gemini, Claude, Copilot, Grok')
    expect(container.querySelector('textarea')).toBeNull()
    act(() => button(container, 'I understand, continue')!.click())
    expect(setConsent).toHaveBeenCalledTimes(1)
    expect(container.querySelector('textarea')).not.toBeNull()
    expect(ask).not.toHaveBeenCalled()
  })

  it('runs the three engines, shows per-engine results, and "use this" replaces the selection', async () => {
    const ask = vi.fn(async (req: { siteId: string; prompt: string }) =>
      req.siteId === 'claude'
        ? { ok: false as const, reason: 'not signed in' }
        : req.siteId === 'grok'
          ? { ok: false as const, reason: 'login-wall' }
          : { ok: true as const, text: `${req.siteId} polished` },
    )
    const chat = vi.fn()
    const { container, editor, onClose } = setup({
      compareDetect: async () => ({ installed: true, path: '/x' }),
      compareGetConsent: async () => true,
      compareSetConsent: async () => true,
      compareAsk: ask,
      compareCancel: async () => {},
      aiChat: chat,
    })
    await flush()
    const area = container.querySelector('textarea')!
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      set.call(area, '매출이 8퍼센트 늘었다.')
      area.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => button(container, 'Compare')!.click())
    await flush()
    expect(ask).toHaveBeenCalledTimes(4)
    const prompts = new Set(ask.mock.calls.map((c) => c[0].prompt))
    expect(prompts.size).toBe(1)
    expect([...prompts][0]).toContain('Original Korean:\n매출이 8퍼센트 늘었다.')
    expect([...prompts][0]).toContain('English text:\neight percent')
    expect(container.textContent).toContain('not signed in')
    // a site that cannot be chatted with is a quiet skipped row, not a failure with a reason
    const grokCard = [...container.querySelectorAll('.cmp-card')].find((c) =>
      c.textContent?.includes('Grok'),
    )!
    expect(grokCard.textContent).toContain('Skipped (not logged in)')
    expect(grokCard.textContent).not.toContain('login-wall')
    expect(grokCard.querySelector('.cmp-chip-failed')).toBeNull()
    expect(button(container, 'Retry')).toBeDefined()
    // integration is blocked (no connected AI in this fake): reported, nothing sent
    expect(chat).not.toHaveBeenCalled()
    const useButtons = [...container.querySelectorAll('.cmp-card')]
      .find((card) => card.textContent?.includes('Copilot'))!
      .querySelectorAll('button')
    act(() => [...useButtons].find((b) => b.textContent === 'Use this')!.click())
    expect(editor.state.doc.textContent).toBe('Revenue grew copilot polished.')
    expect(onClose).toHaveBeenCalled()
  })

  it('says so and offers the manual fallback when no engine answered', async () => {
    const ask = vi.fn(async (req: { siteId: string }) =>
      req.siteId === 'claude'
        ? { ok: false as const, reason: 'needs-user' }
        : { ok: false as const, reason: 'no-prompt-box' },
    )
    const { container } = setup({
      compareDetect: async () => ({ installed: true, path: '/x' }),
      compareGetConsent: async () => true,
      compareAsk: ask,
      compareCancel: async () => {},
    })
    await flush()
    const area = container.querySelector('textarea')!
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      set.call(area, '원문')
      area.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => button(container, 'Compare')!.click())
    await flush()
    expect(container.textContent).toContain('No engine answered.')
    expect(container.textContent).toContain('Handle the prompt in the ego lite window')
    expect(button(container, 'Copy prompt and open Gemini')).toBeDefined()
    expect(container.textContent).not.toContain('Done')
  })

  it('Escape closes it', async () => {
    const { onClose } = setup({
      compareDetect: async () => ({ installed: true, path: '/x' }),
      compareGetConsent: async () => true,
    })
    await flush()
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
