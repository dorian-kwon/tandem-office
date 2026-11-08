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

function setup(
  desktop: Record<string, unknown>,
  bodyText = 'Revenue grew eight percent.',
  range?: [number, number],
) {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: {
      type: 'doc',
      content: [
        {
          type: 'docParagraph',
          attrs: { docxIndex: null },
          content: [{ type: 'text', text: bodyText }],
        },
      ],
    } as never,
  })
  editor.commands.setTextSelection(range ? { from: range[0], to: range[1] } : { from: 14, to: 27 })
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

  it('shows consent first, remembers it, sends nothing before then and starts at once after', async () => {
    const setConsent = vi.fn(async () => true)
    const ask = vi.fn(async () => ({ ok: true as const, text: 'x' }))
    const { container } = setup({
      compareDetect: async () => ({ installed: true, path: '/x' }),
      compareGetConsent: async () => false,
      compareSetConsent: setConsent,
      compareAsk: ask,
      compareCancel: async () => {},
    })
    await flush()
    expect(container.textContent).toContain('Gemini, Claude, Copilot, Grok')
    expect(container.querySelector('.cmp-cards')).toBeNull()
    expect(ask).not.toHaveBeenCalled()
    act(() => button(container, 'I understand, continue')!.click())
    await flush()
    expect(setConsent).toHaveBeenCalledTimes(1)
    // no input needed: it started by itself, with only the selection
    expect(ask).toHaveBeenCalledTimes(4)
  })

  const noOriginalDesktop = (ask: unknown, extra: Record<string, unknown> = {}) => ({
    compareDetect: async () => ({ installed: true, path: '/x' }),
    compareGetConsent: async () => true,
    compareSetConsent: async () => true,
    compareAsk: ask,
    compareCancel: async () => {},
    ...extra,
  })

  it('starts by itself with only the selection, shows per-engine results, and "use this" replaces it', async () => {
    const ask = vi.fn(async (req: { siteId: string; prompt: string }) =>
      req.siteId === 'claude'
        ? { ok: false as const, reason: 'not signed in' }
        : req.siteId === 'grok'
          ? { ok: false as const, reason: 'login-wall' }
          : { ok: true as const, text: `${req.siteId} translated` },
    )
    const chat = vi.fn()
    const { container, editor, onClose } = setup(
      noOriginalDesktop(ask, {
        aiChat: chat,
        getTranslationLanguages: async () => ({ sourceLang: 'ko', targetLang: 'ja' }),
      }),
    )
    await flush()
    // nothing was typed or clicked: the run is already going, in selection-only mode
    expect(ask).toHaveBeenCalledTimes(4)
    const prompts = new Set(ask.mock.calls.map((c) => c[0].prompt))
    expect(prompts.size).toBe(1)
    const prompt = [...prompts][0]!
    expect(prompt).toContain('Translate the following text into Japanese.')
    expect(prompt).toContain('\n\neight percent')
    expect(prompt).not.toContain('Original Korean:')
    // the original field is collapsed and the re-translation switch is hidden in this mode
    expect(container.querySelector('textarea')).toBeNull()
    expect(button(container, 'Add original')).toBeDefined()
    expect(container.textContent).not.toContain('Include re-translation')
    expect(container.textContent).toContain('not signed in')
    const grokCard = [...container.querySelectorAll('.cmp-card')].find((c) =>
      c.textContent?.includes('Grok'),
    )!
    expect(grokCard.textContent).toContain('Skipped (not logged in)')
    expect(grokCard.textContent).not.toContain('login-wall')
    expect(grokCard.querySelector('.cmp-chip-failed')).toBeNull()
    expect(button(container, 'Retry')).toBeDefined()
    // integration is blocked (no connected AI in this fake): nothing sent
    expect(chat).not.toHaveBeenCalled()
    const copilot = [...container.querySelectorAll('.cmp-card')].find((card) =>
      card.textContent?.includes('Copilot'),
    )!
    act(() =>
      [...copilot.querySelectorAll('button')].find((b) => b.textContent === 'Use this')!.click(),
    )
    expect(editor.state.doc.textContent).toBe('Revenue grew copilot translated.')
    expect(onClose).toHaveBeenCalled()
  })

  it('with an added original it asks for the polish plus a re-translation and shows two cards per engine', async () => {
    const reply = '[POLISHED]\nPolished by site\n[RETRANSLATION]\nFresh by site'
    const ask = vi.fn(async () => ({ ok: true as const, text: reply }))
    const setRe = vi.fn(async () => true)
    const { container } = setup(noOriginalDesktop(ask, { compareSetRetranslate: setRe }))
    await flush()
    expect(ask).toHaveBeenCalledTimes(4)
    act(() => button(container, 'Add original')!.click())
    const area = container.querySelector('textarea')!
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      set.call(area, '매출이 8퍼센트 늘었다.')
      area.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.textContent).toContain('Include re-translation')
    ask.mockClear()
    act(() => button(container, 'Compare')!.click())
    await flush()
    expect(ask).toHaveBeenCalledTimes(4)
    const prompt = (ask.mock.calls[0] as unknown as [{ prompt: string }])[0].prompt
    expect(prompt).toContain('Original Korean:\n매출이 8퍼센트 늘었다.')
    expect(prompt).toContain('[RETRANSLATION]')
    const titles = [...container.querySelectorAll('.cmp-card-title')].map((e) => e.textContent)
    expect(titles).toContain('Gemini · Polished')
    expect(titles).toContain('Gemini · Re-translated')
    expect(titles.filter((x) => x?.startsWith('Claude'))).toHaveLength(2)
    // the switch is remembered and, when off, the prompt is the polishing-only one
    const box = [
      ...container.querySelectorAll('label.cmp-retranslate input'),
    ][0] as HTMLInputElement
    act(() => box.click())
    expect(setRe).toHaveBeenCalledWith(false)
    ask.mockClear()
    act(() => button(container, 'Compare')!.click())
    await flush()
    const plain = (ask.mock.calls[0] as unknown as [{ prompt: string }])[0].prompt
    expect(plain).toContain('Reply with the polished English text only')
    expect(plain).not.toContain('[RETRANSLATION]')
  })

  it('cuts a very long selection, says so and turns "use this" off', async () => {
    const ask = vi.fn(async () => ({ ok: true as const, text: 'short' }))
    const long = 'word '.repeat(1200)
    const { container } = setup(noOriginalDesktop(ask), long, [1, long.length])
    await flush()
    const prompt = (ask.mock.calls[0] as unknown as [{ prompt: string }])[0].prompt
    expect(prompt.length).toBeLessThan(4400)
    expect(container.textContent).toContain('Only the first 4000 characters were sent')
    const use = [...container.querySelectorAll('button')].filter(
      (b) => b.textContent === 'Use this',
    )
    expect(use.length).toBeGreaterThan(0)
    for (const b of use) expect((b as HTMLButtonElement).disabled).toBe(true)
  })

  it('says so and offers the manual fallback when no engine answered', async () => {
    const ask = vi.fn(async (req: { siteId: string }) =>
      req.siteId === 'claude'
        ? { ok: false as const, reason: 'needs-user' }
        : { ok: false as const, reason: 'no-prompt-box' },
    )
    const { container } = setup(noOriginalDesktop(ask))
    await flush()
    expect(container.textContent).toContain('No engine answered.')
    expect(container.textContent).toContain(
      'handle the prompt or close the site’s cookie notice once',
    )
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
