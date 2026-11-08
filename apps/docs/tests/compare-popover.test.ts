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
  vi.useRealTimers()
  delete (window as unknown as { desktop?: unknown }).desktop
  delete (window as unknown as { aiOfficeSubscription?: unknown }).aiOfficeSubscription
})
beforeAll(() => {
  Element.prototype.scrollTo ??= () => {}
})

function setup(
  desktop: Record<string, unknown>,
  bodyText: string | string[] = 'Revenue grew eight percent.',
  range?: [number, number],
  appSettings: AiSettings = settings,
  initial: 'en' | 'ko' = 'en',
) {
  const offline = Object.fromEntries(
    ['claude-code', 'codex', 'chatgpt'].map((provider) => [
      provider,
      { provider, state: 'signed-out' },
    ]),
  )
  ;(window as unknown as { aiOfficeSubscription: unknown }).aiOfficeSubscription = {
    statuses: async () => desktop.subscriptionStatuses ?? offline,
    onChanged: () => () => {},
  }
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: {
      type: 'doc',
      content: (Array.isArray(bodyText) ? bodyText : [bodyText]).map((text) => ({
        type: 'docParagraph',
        attrs: { docxIndex: null },
        content: [{ type: 'text', text }],
      })),
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
        { initial, children: null },
        createElement(AiComparePopover, {
          editor,
          snapshot,
          settings: appSettings,
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

const ready = (extra: Record<string, unknown> = {}) => ({
  compareDetect: async () => ({ installed: true, path: '/fake/ego' }),
  compareGetConsent: async () => true,
  compareGetPrefs: async () => ({
    autoIntegrate: false,
    engines: { 'connected-anthropic': false },
  }),
  compareSetPrefs: async () => true,
  compareCancel: async () => {},
  ...extra,
})
async function start(container: HTMLElement): Promise<void> {
  act(() => button(container, 'Compare')!.click())
  await flush()
}

describe('AI compare popup', () => {
  it('offers an installation page, rechecks on request, and cannot start before installation', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const detect = vi
      .fn()
      .mockResolvedValueOnce({ installed: false })
      .mockResolvedValueOnce({ installed: true })
    const { container } = setup(ready({ compareDetect: detect }))
    await flush()
    expect(container.textContent).toContain('The ego browser is not installed. Install it?')
    expect(button(container, 'Compare')?.disabled).toBe(true)
    expect(open).not.toHaveBeenCalled()
    act(() => button(container, 'Install')!.click())
    expect(open).toHaveBeenCalledWith(EGO_INSTALL_URL)
    expect(container.textContent).toContain('never downloads or runs the installer')
    act(() => button(container, 'Check again')!.click())
    await flush()
    expect(button(container, 'Compare')?.disabled).toBe(false)
  })

  it('requires consent and explicit start before sending to the enabled engine', async () => {
    const asks: Array<{ siteId: string; prompt: string }> = []
    const { container } = setup(
      ready({
        compareGetConsent: async () => false,
        compareSetConsent: async () => true,
        compareAsk: async (request: { siteId: string; prompt: string }) => {
          asks.push(request)
          return { ok: true, text: 'Answer' }
        },
      }),
    )
    await flush()
    expect(container.textContent).toContain('Copilot')
    expect(asks).toEqual([])
    act(() => button(container, 'I understand, continue')!.click())
    await flush()
    expect(asks).toEqual([])
    await start(container)
    expect(asks).toHaveLength(1)
    expect(asks[0]?.siteId).toBe('copilot')
    expect(asks[0]?.prompt).toContain('eight percent')
  })

  it('requires fresh consent and never routes the connected AI through the retired website', async () => {
    const web: string[] = []
    const appRequests: Array<{ requestId: string; settings: AiSettings }> = []
    let listener: ((chunk: { requestId: string; type: string; text?: string }) => void) | undefined
    const current = {
      ...settings,
      providers: {
        ...settings.providers,
        anthropic: { ...settings.providers.anthropic, apiKey: 'fake-key', model: 'current-model' },
      },
    }
    const { container } = setup(
      ready({
        compareGetConsent: async () => false,
        compareDetect: async () => ({ installed: false }),
        compareSetConsent: async () => true,
        compareGetPrefs: async () => ({
          engines: { copilot: false, grok: false, chatgpt: false },
          autoIntegrate: true,
        }),
        getAiSettings: async () => current,
        compareAsk: async (request: { siteId: string }) => {
          web.push(request.siteId)
          return { ok: true, text: 'Web answer' }
        },
        onAiStream: (fn: typeof listener) => {
          listener = fn
          return () => {
            listener = undefined
          }
        },
        aiStream: async (request: { requestId: string; settings: AiSettings }) => {
          appRequests.push(request)
          listener?.({ requestId: request.requestId, type: 'delta', text: 'Connected answer' })
          listener?.({ requestId: request.requestId, type: 'done' })
        },
      }),
      undefined,
      undefined,
      current,
    )
    await flush()
    expect(appRequests).toEqual([])
    act(() => button(container, 'I understand, continue')!.click())
    await flush()
    expect(appRequests).toEqual([])
    expect(
      [...container.querySelectorAll('label')].some((l) =>
        l.textContent?.includes('Claude · current-model'),
      ),
    ).toBe(true)
    await start(container)
    expect(web).toEqual([])
    expect(appRequests).toHaveLength(2)
    expect(appRequests[0]?.settings).toEqual(current)
    expect(container.textContent).toContain('Connected answer')
    expect(button(container, 'Copy prompt and open ChatGPT')).toBeUndefined()
    expect(
      [...container.querySelectorAll('.cmp-card-title')].some(
        (c) => c.textContent === 'Claude · current-model',
      ),
    ).toBe(true)
  })

  it('lists ready providers with default-on switches, pins the main AI and integrates with its candidate off', async () => {
    const current: AiSettings = {
      ...settings,
      provider: 'claude-code',
      subscriptionNoticeSeen: true,
    }
    const statuses = Object.fromEntries(
      ['claude-code', 'chatgpt', 'codex'].map((provider) => [
        provider,
        { provider, state: 'ready' },
      ]),
    )
    const listeners = new Set<(chunk: { requestId: string; type: string; text?: string }) => void>()
    const requests: Array<{ requestId: string; settings: AiSettings }> = []
    const prefs: unknown[] = []
    const { container } = setup(
      ready({
        subscriptionStatuses: statuses,
        compareGetPrefs: async () => ({ engines: { copilot: false } }),
        compareSetPrefs: async (patch: unknown) => {
          prefs.push(patch)
        },
        onAiStream: (fn: (chunk: { requestId: string; type: string; text?: string }) => void) => {
          listeners.add(fn)
          return () => {
            listeners.delete(fn)
          }
        },
        aiStream: async (req: { requestId: string; settings: AiSettings }) => {
          requests.push(req)
        },
      }),
      undefined,
      undefined,
      current,
    )
    await flush()
    const switches = [...container.querySelectorAll<HTMLInputElement>('input[role="switch"]')]
    expect(switches).toHaveLength(4)
    expect(switches.slice(1).every((input) => input.checked)).toBe(true)
    expect(container.textContent).toContain('Claude Code')
    expect(container.textContent).toContain('ChatGPT')
    expect(container.textContent).toContain('Codex CLI')
    expect(container.querySelectorAll('.cmp-switches .cmp-chip').length).toBe(3)
    const mainSwitch = [...container.querySelectorAll('label')]
      .find((label) => label.textContent?.startsWith('Claude Code'))!
      .querySelector('input')!
    act(() => mainSwitch.click())
    expect(prefs).toEqual([{ engines: { 'connected-claude-code': false } }])
    await start(container)
    expect(requests.map((r) => r.settings.provider).sort()).toEqual(['chatgpt', 'codex'])
    expect(switches.every((input) => input.disabled)).toBe(true)
    // Changing the original settings must not change the run's main route/model.
    current.provider = 'codex'
    await act(async () => {
      for (const req of [...requests]) {
        for (const fn of [...listeners])
          fn({ requestId: req.requestId, type: 'delta', text: 'One candidate' })
        for (const fn of [...listeners]) fn({ requestId: req.requestId, type: 'done' })
      }
      await Promise.resolve()
    })
    await flush()
    expect(requests).toHaveLength(3)
    expect(requests[2]?.settings.provider).toBe('claude-code')
    await act(async () => {
      const req = requests[2]!
      for (const fn of [...listeners])
        fn({ requestId: req.requestId, type: 'delta', text: 'Final combined answer' })
      for (const fn of [...listeners]) fn({ requestId: req.requestId, type: 'done' })
    })
    await flush()
    expect(container.textContent).toContain('Final combined answer')
  })

  it('lets the person select one answer and keeps the popup available for other units', async () => {
    const { container, editor, onClose } = setup(
      ready({ compareAsk: async () => ({ ok: true, text: '8%' }) }),
    )
    await flush()
    await start(container)
    const copilot = [...container.querySelectorAll('.cmp-card')].find(
      (c) => c.querySelector('.cmp-card-title')?.textContent === 'Copilot',
    )!
    act(() => button(copilot as HTMLElement, 'Use this')!.click())
    expect(editor.state.doc.textContent).toBe('Revenue grew 8%.')
    expect(container.textContent).toContain('Applied')
    expect(button(copilot as HTMLElement, 'Use this')?.disabled).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
    editor.commands.undo()
    expect(editor.state.doc.textContent).toBe('Revenue grew eight percent.')
  })

  it('disables Compare when every engine switch is off and remembers the switch', async () => {
    const prefs: unknown[] = []
    const { container } = setup(
      ready({
        compareSetPrefs: async (patch: unknown) => {
          prefs.push(patch)
          return true
        },
      }),
    )
    await flush()
    const copilot = container.querySelector('input[role="switch"]') as HTMLInputElement
    act(() => copilot.click())
    expect(button(container, 'Compare')?.disabled).toBe(true)
    expect(container.textContent).toContain('Turn on at least one engine.')
    expect(prefs).toEqual([{ engines: { copilot: false } }])
  })

  it('asks about the whole document in paragraph order, not just the captured selection', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const asks: string[] = []
    const { container, editor } = setup(
      ready({
        compareAsk: async (req: { prompt: string }) => {
          asks.push(req.prompt)
          return { ok: true, text: 'Answer' }
        },
      }),
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    act(() =>
      editor.commands.setContent({
        type: 'doc',
        content: ['First paragraph', 'Second paragraph'].map((text) => ({
          type: 'docParagraph',
          content: [{ type: 'text', text }],
        })),
      }),
    )
    const documentScope = container.querySelectorAll('input[type="radio"]')[1] as HTMLInputElement
    act(() => documentScope.click())
    act(() => button(container, 'Compare')!.click())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(asks).toHaveLength(1)
    expect(asks[0]).toContain('First paragraph')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(asks).toHaveLength(2)
    expect(asks[1]).toContain('Second paragraph')
    expect(container.querySelectorAll('.cmp-unit')).toHaveLength(2)
  })

  it('never retries a blocked engine and displays why the run stopped', async () => {
    const asks: string[] = []
    const { container } = setup(
      ready({
        compareAsk: async (req: { siteId: string }) => {
          asks.push(req.siteId)
          return { ok: false, reason: 'blocked' }
        },
      }),
    )
    await flush()
    await start(container)
    expect(asks).toEqual(['copilot'])
    expect(container.textContent).toContain('All engines are blocked.')
    expect(button(container, 'Retry')).toBeUndefined()
  })

  it('describes failed input as an interaction failure rather than a site block', async () => {
    const { container } = setup(
      ready({ compareAsk: async () => ({ ok: false, reason: 'input-not-accepted' }) }),
    )
    await flush()
    await start(container)
    expect(container.textContent).toContain('The site did not retain the text. Nothing was sent.')
    expect(container.querySelector('.cmp-chip-failed')).not.toBeNull()
    expect(container.querySelector('.cmp-chip-blocked')).toBeNull()
  })

  it('warns about a truncated unit and disables replacement', async () => {
    const long = 'word '.repeat(1200)
    const { container } = setup(
      ready({ compareAsk: async () => ({ ok: true, text: 'Short' }) }),
      long,
      [1, long.length],
    )
    await flush()
    await start(container)
    expect(container.textContent).toContain('Only the first 4000 characters were sent')
    const uses = [...container.querySelectorAll('button')].filter(
      (b) => b.textContent === 'Use this',
    )
    expect(uses.length).toBeGreaterThan(0)
    expect(uses.every((b) => b.disabled)).toBe(true)
  })

  it('refuses a candidate when the paragraph was edited after the request', async () => {
    const { container, editor } = setup(
      ready({ compareAsk: async () => ({ ok: true, text: '8%' }) }),
    )
    await flush()
    await start(container)
    act(() => editor.commands.insertContentAt(15, 'X'))
    const copilot = [...container.querySelectorAll('.cmp-card')].find(
      (c) => c.querySelector('.cmp-card-title')?.textContent === 'Copilot',
    )!
    act(() => button(copilot as HTMLElement, 'Use this')!.click())
    expect(container.textContent).toContain('Nothing was replaced.')
    expect(editor.state.doc.textContent).toContain('eXight')
  })

  it('does not send a captured selection after its text was edited before Compare', async () => {
    const asks: string[] = []
    const { container, editor } = setup(
      ready({
        compareAsk: async () => {
          asks.push('sent')
          return { ok: true, text: 'Answer' }
        },
      }),
    )
    await flush()
    act(() => editor.commands.insertContentAt(15, 'X'))
    await start(container)
    expect(asks).toEqual([])
    expect(container.textContent).toContain('Nothing was replaced.')
  })

  it('automatically integrates through the main AI even when its candidate switch is off', async () => {
    let listener: ((chunk: { requestId: string; type: string; text?: string }) => void) | undefined
    const requests: Array<{ requestId: string }> = []
    const preferences: unknown[] = []
    const appSettings: AiSettings = {
      ...settings,
      providers: {
        ...settings.providers,
        anthropic: { ...settings.providers.anthropic, apiKey: 'fake-key' },
      },
    }
    const { container } = setup(
      ready({
        compareGetPrefs: async () => ({ engines: { 'connected-anthropic': false } }),
        compareSetPrefs: async (patch: unknown) => {
          preferences.push(patch)
          return true
        },
        compareAsk: async () => ({ ok: true, text: 'Web candidate' }),
        onAiStream: (fn: typeof listener) => {
          listener = fn
          return () => {
            listener = undefined
          }
        },
        aiStream: async (request: { requestId: string }) => {
          requests.push(request)
          listener?.({ requestId: request.requestId, type: 'delta', text: 'Combined answer' })
          listener?.({ requestId: request.requestId, type: 'done' })
        },
      }),
      undefined,
      undefined,
      appSettings,
    )
    await flush()
    expect(container.textContent).toContain('Claude')
    expect(container.textContent).toContain('Automatically')
    expect(
      [...container.querySelectorAll('label')].some(
        (label) => label.textContent?.trim() === 'Auto integrate',
      ),
    ).toBe(false)
    await start(container)
    expect(requests).toHaveLength(1)
    expect(preferences).toEqual([])
    expect(container.textContent).toContain('Combined answer')
  })

  it('uses the app stream for automatic integration and cancels that request on Stop', async () => {
    let listener: ((chunk: { requestId: string; type: string; text?: string }) => void) | undefined
    const requests: Array<{ requestId: string; tools: unknown[] }> = []
    const cancelled: string[] = []
    const appSettings: AiSettings = {
      ...settings,
      providers: {
        ...settings.providers,
        anthropic: { ...settings.providers.anthropic, apiKey: 'fake-key' },
      },
    }
    const { container } = setup(
      ready({
        compareGetPrefs: async () => ({
          autoIntegrate: true,
          engines: { 'connected-anthropic': false },
        }),
        compareAsk: async () => ({ ok: true, text: 'Candidate' }),
        onAiStream: (fn: typeof listener) => {
          listener = fn
          return () => {
            listener = undefined
          }
        },
        aiStream: async (req: { requestId: string; tools: unknown[] }) => {
          requests.push(req)
          listener?.({ requestId: req.requestId, type: 'delta', text: 'partial' })
        },
        aiStreamCancel: async (id: string) => {
          cancelled.push(id)
        },
      }),
      undefined,
      undefined,
      appSettings,
    )
    await flush()
    await start(container)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.tools).toEqual([])
    act(() => button(container, 'Stop')!.click())
    await flush()
    expect(cancelled).toEqual([requests[0]!.requestId])
    expect(container.textContent).not.toContain('partial')
  })

  it('asks one improvement with original context and shows exactly one answer card', async () => {
    const prompts: string[] = []
    const { container } = setup(
      ready({
        compareAsk: async (request: { prompt: string }) => {
          prompts.push(request.prompt)
          return { ok: true, text: 'One finished answer' }
        },
      }),
    )
    await flush()
    expect(container.querySelector('.cmp-retranslate')).toBeNull()
    act(() => button(container, 'Add original')!.click())
    const area = container.querySelector('textarea')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        area,
        '한국어 원문',
      )
      area.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await start(container)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('Improve the following English translation')
    expect(prompts[0]).not.toMatch(/POLISHED|RETRANSLATION|two sections/)
    expect(
      [...container.querySelectorAll('.cmp-card-title')].filter((c) => c.textContent === 'Copilot'),
    ).toHaveLength(1)
    expect(container.textContent).toContain('One finished answer')
  })

  it('defaults Korean UI/source to English and preserves an explicitly chosen target', async () => {
    const prompts: string[] = []
    const text = '한국어 원문입니다'
    const { container } = setup(
      ready({
        compareAsk: async (request: { prompt: string }) => {
          prompts.push(request.prompt)
          return { ok: true, text: 'Answer' }
        },
      }),
      text,
      [1, text.length + 1],
      settings,
      'ko',
    )
    await flush()
    const select = container.querySelector('select')!
    expect(select.value).toBe('en')
    act(() =>
      (container.querySelector('.cmp-actions .ai-ask-confirm') as HTMLButtonElement).click(),
    )
    await flush()
    expect(prompts[0]).toContain('Translate the following text into English.')
    act(() => {
      select.value = 'fr'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    act(() =>
      (container.querySelector('.cmp-actions .ai-ask-confirm') as HTMLButtonElement).click(),
    )
    await flush()
    expect(prompts[1]).toContain('Translate the following text into French.')
    expect(select.value).toBe('fr')
  })

  it('retry all resends only a failed unit and preserves an already applied successful answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const requests: string[] = []
    const { container, editor } = setup(
      ready({
        compareAsk: async (request: { prompt: string }) => {
          requests.push(request.prompt)
          return requests.length === 1
            ? { ok: false, reason: 'temporary failure' }
            : {
                ok: true,
                text: request.prompt.includes('Second') ? 'Second answer' : 'First answer',
              }
        },
      }),
      ['First', 'Second'],
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    act(() => (container.querySelectorAll('input[type=radio]')[1] as HTMLInputElement).click())
    act(() => button(container, 'Compare')!.click())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    const rows = [...container.querySelectorAll('.cmp-unit')]
    act(() => (rows[1]!.querySelector('.cmp-unit-row') as HTMLElement).click())
    const copilot = [...rows[1]!.querySelectorAll('.cmp-card')].find(
      (c) => c.querySelector('.cmp-card-title')?.textContent === 'Copilot',
    )!
    act(() => button(copilot as HTMLElement, 'Use this')!.click())
    act(() => button(container, 'Retry all failed')!.click())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(requests).toHaveLength(3)
    expect(requests[2]).toContain('First')
    expect(editor.state.doc.child(0).textContent).toBe('First')
    expect(editor.state.doc.child(1).textContent).toBe('Second answer')
    expect(rows[1]?.textContent).toContain('Applied')
  })

  it('does not resend changed text through either individual or global retry', async () => {
    let calls = 0
    const { container, editor } = setup(
      ready({
        compareAsk: async () => {
          calls++
          return { ok: false, reason: 'temporary failure' }
        },
      }),
    )
    await flush()
    await start(container)
    act(() => editor.commands.insertContentAt(15, 'X'))
    act(() => button(container, 'Retry all failed')!.click())
    await flush()
    act(() => button(container, 'Retry')!.click())
    await flush()
    expect(calls).toBe(1)
    expect(container.textContent).toContain('Changed text was skipped')
  })

  it('keeps prompt options fixed when project language loading finishes during a run', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let loadLanguage!: (pair: { targetLang: string }) => void
    const prompts: string[] = []
    const { container } = setup(
      ready({
        compareGetPrefs: async () => ({
          autoIntegrate: false,
          engines: { 'connected-anthropic': false },
        }),
        getTranslationLanguages: () =>
          new Promise((resolve) => {
            loadLanguage = resolve
          }),
        compareAsk: async (req: { prompt: string }) => {
          prompts.push(req.prompt)
          return { ok: true, text: 'Answer' }
        },
      }),
      ['Repeated paragraph', 'Repeated paragraph'],
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    act(() => (container.querySelectorAll('input[type=radio]')[1] as HTMLInputElement).click())
    act(() => button(container, 'Compare')!.click())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      loadLanguage({ targetLang: 'ja' })
      await Promise.resolve()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toBe(prompts[0])
  })

  it('starts web and connected AI together and closing cancels both requests', async () => {
    const web: string[] = []
    const app: string[] = []
    const cancelledWeb: string[] = []
    const cancelledApp: string[] = []
    let finishWeb!: (answer: { ok: false; reason: string }) => void
    const current = {
      ...settings,
      providers: {
        ...settings.providers,
        anthropic: { ...settings.providers.anthropic, apiKey: 'fake-key' },
      },
    }
    const { container } = setup(
      ready({
        compareGetPrefs: async () => ({ autoIntegrate: true }),
        getAiSettings: async () => current,
        compareAsk: (request: { id: string }) => {
          web.push(request.id)
          return new Promise((resolve) => {
            finishWeb = resolve
          })
        },
        compareCancel: async (id: string) => {
          cancelledWeb.push(id)
        },
        onAiStream: () => () => {},
        aiStream: async (request: { requestId: string }) => {
          app.push(request.requestId)
        },
        aiStreamCancel: async (id: string) => {
          cancelledApp.push(id)
        },
      }),
      undefined,
      undefined,
      current,
    )
    await flush()
    await start(container)
    expect(web).toHaveLength(1)
    expect(app).toHaveLength(1)
    expect(container.querySelectorAll('.cmp-chip-running').length).toBeGreaterThanOrEqual(2)
    cleanups.pop()!()
    expect(cancelledWeb).toEqual(web)
    expect(cancelledApp).toEqual(app)
    finishWeb({ ok: false, reason: 'stopped' })
    await flush()
  })

  it('selection scope sends and replaces only the selected portions of its boundary paragraphs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const prompts: string[] = []
    const { container, editor } = setup(
      ready({
        compareAsk: async (req: { prompt: string }) => {
          prompts.push(req.prompt)
          return { ok: true, text: 'Changed' }
        },
      }),
      ['Outside before FIRST', 'MIDDLE', 'LAST outside after'],
      [16, 35],
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    act(() => button(container, 'Compare')!.click())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000)
    })
    expect(prompts).toHaveLength(3)
    expect(prompts[0]).toContain('FIRST')
    expect(prompts[1]).toContain('MIDDLE')
    expect(prompts[2]).toContain('LAST')
    expect(prompts.join('')).not.toContain('Outside before')
    expect(prompts.join('')).not.toContain('outside after')
    const unitRows = [...container.querySelectorAll('.cmp-unit')]
    act(() => (unitRows[2]!.querySelector('.cmp-unit-row') as HTMLElement).click())
    for (const index of [0, 2]) {
      const card = [...unitRows[index]!.querySelectorAll('.cmp-card')].find(
        (c) => c.querySelector('.cmp-card-title')?.textContent === 'Copilot',
      )!
      act(() => button(card as HTMLElement, 'Use this')!.click())
    }
    expect(editor.state.doc.child(0).textContent).toBe('Outside before Changed')
    expect(editor.state.doc.child(1).textContent).toBe('MIDDLE')
    expect(editor.state.doc.child(2).textContent).toBe('Changed outside after')
  })

  it('Escape closes the popup', async () => {
    const { onClose } = setup(ready())
    await flush()
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
