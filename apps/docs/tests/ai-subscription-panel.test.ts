// The AI panel under the subscription contract: a send while nothing is
// connected is answered by the connect cards instead of a run, a send made
// during the status check waits for its answer, a blocked run offers "continue
// with ...", the first run on a subscription waits for the notice, and usage /
// a cut input reported by the main process are shown.
// Every request goes to a mocked preload bridge: no provider is started.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Editor } from '@tiptap/core'
import type { AiSubscriptionState, SubscriptionStatusMap } from '@genoffice/ai-provider/browser'
import { AI_SUBSCRIPTION_STRINGS } from '@genoffice/ui'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { AiPanel } from '../src/renderer/ai/AiPanel'
import {
  AI_PROVIDERS,
  type AiProviderId,
  type AiSettings,
  type AiStreamChunk,
  type AiStreamRequest,
} from '../src/shared/ipc'

type ChunkListener = (chunk: AiStreamChunk) => void

function settingsWith(
  provider: AiSettings['provider'],
  patch: Partial<AiSettings> = {},
): AiSettings {
  return {
    provider,
    providers: Object.fromEntries(
      AI_PROVIDERS.map((p) => [
        p.id,
        p.id === provider
          ? { apiKey: 'k', model: p.defaultModel || 'm' }
          : { apiKey: '', model: p.defaultModel },
      ]),
    ) as AiSettings['providers'],
    ...patch,
  }
}

function statuses(claude: AiSubscriptionState, codex: AiSubscriptionState): SubscriptionStatusMap {
  return {
    'claude-code': { provider: 'claude-code', state: claude, meteredAccepted: false },
    chatgpt: { provider: 'chatgpt', state: 'signed-out', meteredAccepted: false },
    codex: { provider: 'codex', state: codex, meteredAccepted: false },
  }
}

function createEditor(): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: {
      type: 'doc',
      content: [
        {
          type: 'docParagraph',
          attrs: { docxIndex: 0 },
          content: [{ type: 'text', text: 'EVs market research' }],
        },
      ],
    },
  })
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await flush()
  })
}

interface Harness {
  container: HTMLElement
  requests: AiStreamRequest[]
  setAiSettings: ReturnType<typeof vi.fn>
  recheck: ReturnType<typeof vi.fn>
  send(text: string): Promise<void>
  /** type a message and press Enter: while a reply runs, that queues it */
  typeAndEnter(text: string): Promise<void>
  composerText(): string
  /** the main process reports a status change */
  setStatuses(next: SubscriptionStatusMap): Promise<void>
  /** the app hands the panel newly read settings */
  setSettings(next: AiSettings): Promise<void>
  editor: Editor
  cancelRequests: ReturnType<typeof vi.fn>
  cleanup(): void
}

/** records what the panel scrolls into view (jsdom implements no scrolling of its own) */
function watchScrollIntoView(): Element[] {
  const scrolled: Element[] = []
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this)
  }
  return scrolled
}

/**
 * Mount the panel over a mocked bridge. `answer` plays the main process for
 * each request: it gets the request and a function to emit chunks with.
 */
async function mountPanel(options: {
  editor?: Editor
  notesAccess?: import('../src/renderer/ai/note-ops').AiNotesAccess
  settings: AiSettings
  subscription?: SubscriptionStatusMap
  /** what the settings file holds, when it differs from the panel's copy */
  fileSettings?: AiSettings
  answer: (
    request: AiStreamRequest,
    emit: (chunk: Omit<AiStreamChunk, 'requestId'>) => void,
  ) => void
}): Promise<Harness> {
  const editor = options.editor ?? createEditor()
  const listeners = new Set<ChunkListener>()
  const requests: AiStreamRequest[] = []
  const setAiSettings = vi.fn(async () => {})
  let currentStatuses = options.subscription
  let statusListener: ((next: SubscriptionStatusMap) => void) | null = null
  const recheck = vi.fn(async () => currentStatuses)
  const win = window as unknown as Record<string, unknown>
  const cancelRequests = vi.fn(async () => {})
  win.desktop = {
    onAiStream: (l: ChunkListener) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    aiStream: vi.fn(async (request: AiStreamRequest) => {
      requests.push(request)
      options.answer(request, (chunk) =>
        listeners.forEach((listener) =>
          listener({ ...chunk, requestId: request.requestId } as AiStreamChunk),
        ),
      )
    }),
    aiStreamCancel: cancelRequests,
    setAiSettings,
    ...(options.fileSettings ? { getAiSettings: async () => options.fileSettings } : {}),
    openAiModelSettings: vi.fn(async () => {}),
  }
  if (options.subscription) {
    win.aiOfficeSubscription = {
      statuses: async () => currentStatuses,
      recheck,
      login: vi.fn(async () => ({ ok: true })),
      install: vi.fn(async () => ({ ok: true })),
      setMeteredAccepted: vi.fn(async () => ({ ok: true, statuses: currentStatuses })),
      onChanged: (handler: (next: SubscriptionStatusMap) => void) => {
        statusListener = handler
        return () => {
          statusListener = null
        }
      },
    }
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  const render = (settings: AiSettings) =>
    act(() =>
      root.render(
        createElement(AiPanel, {
          editor,
          notesAccess: options.notesAccess,
          blocks: [],
          settings,
          open: true,
          onExpand: () => {},
          onCollapse: () => {},
        }),
      ),
    )
  render(options.settings)
  // the subscription statuses arrive asynchronously
  await settle()
  const textarea = () => container.querySelector<HTMLTextAreaElement>('.ai-input-box textarea')!
  const type = (text: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    act(() => {
      setter.call(textarea(), text)
      textarea().dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  return {
    container,
    requests,
    editor,
    cancelRequests,
    setAiSettings,
    recheck,
    send: async (text) => {
      type(text)
      act(() => container.querySelector<HTMLButtonElement>('.ai-send-btn')!.click())
      await settle()
    },
    typeAndEnter: async (text) => {
      type(text)
      act(() => {
        textarea().dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
        )
      })
      await settle()
    },
    composerText: () => textarea().value,
    setStatuses: async (next) => {
      currentStatuses = next
      act(() => statusListener?.(next))
      await settle()
    },
    setSettings: async (next) => {
      render(next)
      await settle()
    },
    cleanup: () => {
      act(() => root.unmount())
      container.remove()
      editor.destroy()
    },
  }
}

beforeAll(() => {
  // jsdom's opaque origin has no localStorage; the panel reads it at mount
  let store: Record<string, string> = {}
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v
      },
      removeItem: (k: string) => {
        delete store[k]
      },
      clear: () => {
        store = {}
      },
    },
  })
  Element.prototype.scrollTo ??= () => {}
})

let harness: Harness | null = null
afterEach(() => {
  harness?.cleanup()
  harness = null
  const win = window as unknown as Record<string, unknown>
  delete win.desktop
  delete win.aiOfficeSubscription
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
})

describe('AI panel: failed runs', () => {
  it('keeps the plain error line for a key provider failure', async () => {
    harness = await mountPanel({
      settings: settingsWith('gemini' satisfies AiProviderId),
      answer: (_request, emit) => emit({ type: 'error', error: 'HTTP 429: rate limit' }),
    })
    await harness.send('summarize this')
    const { container } = harness
    expect(container.querySelector('.ai-msg-error')?.textContent).toContain('HTTP 429')
    expect(container.querySelector('.ai-sub-blocked')).toBeNull()
    expect(container.querySelector('.ai-sub-prompt')).toBeNull()
  })

  it('shows the connect cards instead of sending when nothing is connected', async () => {
    const scrolled = watchScrollIntoView()
    harness = await mountPanel({
      settings: settingsWith('auto'),
      subscription: statuses('not-installed', 'signed-out'),
      answer: (_request, emit) =>
        emit({ type: 'error', error: 'No AI is connected.', errorCode: 'not-connected' }),
    })
    const { container } = harness
    // the way to connect is on screen before anything is asked, without drawing attention
    expect(container.querySelector('.ai-sub-prompt')).not.toBeNull()
    expect(scrolled).toEqual([])

    await harness.send('summarize this')
    // nothing was sent, no reply and no error line: the composer keeps the request
    expect(harness.requests).toHaveLength(0)
    expect(container.querySelector('.ai-msg')).toBeNull()
    expect(container.querySelector('.ai-msg-error')).toBeNull()
    expect(harness.composerText()).toBe('summarize this')
    // which AI the user has comes first; each answer leads to its own card
    expect(container.querySelector('.ai-sub-guide-question')).not.toBeNull()
    expect(container.querySelectorAll('.ai-sub-guide-path')).toHaveLength(3)
    // the refused send points at the prompt
    expect(scrolled).toContain(container.querySelector('.ai-sub-prompt'))
  })

  it('does not send the refused request once a subscription connects', async () => {
    harness = await mountPanel({
      settings: settingsWith('auto', { subscriptionNoticeSeen: true }),
      subscription: statuses('not-installed', 'signed-out'),
      answer: (_request, emit) => emit({ type: 'done' }),
    })
    await harness.send('summarize this')
    await harness.setStatuses(statuses('not-installed', 'ready'))
    // minutes may have passed at the sign-in page: the run must be asked for again
    expect(harness.requests).toHaveLength(0)
    expect(harness.composerText()).toBe('summarize this')
    expect(harness.container.querySelector('.ai-sub-prompt')).toBeNull()
  })

  it('shows only the card of a selected subscription that cannot run', async () => {
    harness = await mountPanel({
      settings: settingsWith('codex', { subscriptionNoticeSeen: true }),
      subscription: statuses('ready', 'signed-out'),
      answer: (_request, emit) => emit({ type: 'done' }),
    })
    await harness.send('summarize this')
    // a selection is never replaced by the other subscription, even a ready one
    expect(harness.requests).toHaveLength(0)
    const cards = harness.container.querySelectorAll('.ai-sub-card')
    expect(cards).toHaveLength(1)
    expect(cards[0]?.getAttribute('data-provider')).toBe('codex')
  })

  it('tells the reason and looks again when the main process refuses a run after all', async () => {
    // the panel saw Codex ready; the login had expired by the time the request arrived
    harness = await mountPanel({
      settings: settingsWith('codex', { subscriptionNoticeSeen: true }),
      subscription: statuses('not-installed', 'ready'),
      answer: (_request, emit) =>
        emit({
          type: 'error',
          error: 'Codex is not signed in.',
          errorCode: 'signed-out',
          errorProvider: 'codex',
        }),
    })
    await harness.send('summarize this')
    expect(harness.requests).toHaveLength(1)
    expect(harness.container.querySelector('.ai-msg-error')).toBeNull()
    // the reason is told, but there is nothing to continue on
    expect(harness.container.querySelector('.ai-sub-blocked')).not.toBeNull()
    expect(harness.container.querySelector('[data-action="continue-with"]')).toBeNull()
    // the refusal may rest on an out-of-date status: the panel looks again
    expect(harness.recheck).toHaveBeenCalledWith(['codex'])
  })

  it('offers to continue on the other subscription and reruns the request there', async () => {
    harness = await mountPanel({
      settings: settingsWith('claude-code', { subscriptionNoticeSeen: true }),
      subscription: statuses('ready', 'ready'),
      answer: (request, emit) => {
        if (request.settings.provider === 'claude-code') {
          emit({
            type: 'error',
            error: 'limit reached',
            errorCode: 'rate-limit',
            errorProvider: 'claude-code',
            errorResetsAt: Date.now() + 3_600_000,
          })
        } else {
          emit({ type: 'delta', text: 'done on the other one' })
          emit({ type: 'done' })
        }
      },
    })
    await harness.send('summarize this')
    const { container } = harness
    expect(container.querySelector('.ai-msg-error')).toBeNull()
    // connected: the reason and the button, no connect cards
    expect(container.querySelector('.ai-sub-prompt')).toBeNull()
    const button = container.querySelector<HTMLButtonElement>(
      '.ai-sub-blocked [data-action="continue-with"]',
    )
    expect(button?.getAttribute('data-provider')).toBe('codex')

    act(() => button!.click())
    await settle()
    // the selection is stored (the model picker follows the settings file)...
    expect(harness.setAiSettings).toHaveBeenCalledTimes(1)
    expect(harness.setAiSettings.mock.calls[0]?.[0]).toMatchObject({ provider: 'codex' })
    // ...and the same request ran again on it
    expect(harness.requests).toHaveLength(2)
    expect(harness.requests[1]?.settings.provider).toBe('codex')
    expect(container.textContent).toContain('done on the other one')
    // the offer belonged to the run that had just stopped: the older reply keeps its reason only
    expect(container.querySelector('.ai-sub-blocked')).not.toBeNull()
    expect(container.querySelector('[data-action="continue-with"]')).toBeNull()
  })

  it('offers to continue on the most recent blocked reply only', async () => {
    harness = await mountPanel({
      settings: settingsWith('claude-code', { subscriptionNoticeSeen: true }),
      subscription: statuses('ready', 'ready'),
      answer: (_request, emit) =>
        emit({
          type: 'error',
          error: 'limit reached',
          errorCode: 'rate-limit',
          errorProvider: 'claude-code',
        }),
    })
    await harness.send('summarize this')
    expect(harness.container.querySelectorAll('[data-action="continue-with"]')).toHaveLength(1)
    await harness.send('try once more')
    expect(harness.requests).toHaveLength(2)
    const blocked = [...harness.container.querySelectorAll('.ai-sub-blocked')]
    expect(blocked).toHaveLength(2)
    expect(blocked[0]!.querySelector('[data-action="continue-with"]')).toBeNull()
    expect(blocked[1]!.querySelector('[data-action="continue-with"]')).not.toBeNull()
  })

  it('pauses the message queue, so the next message does not run into the same wall', async () => {
    let fail: (() => void) | null = null
    harness = await mountPanel({
      settings: settingsWith('claude-code', { subscriptionNoticeSeen: true }),
      subscription: statuses('ready', 'ready'),
      // the turn stays in flight until the test fails it
      answer: (_request, emit) => {
        fail = () =>
          emit({
            type: 'error',
            error: 'limit reached',
            errorCode: 'rate-limit',
            errorProvider: 'claude-code',
          })
      },
    })
    await harness.send('summarize this')
    expect(harness.requests).toHaveLength(1)
    // typed while the reply runs: it waits in the queue
    await harness.typeAndEnter('then translate it')
    expect(harness.container.querySelector('.ai-queue-strip')).not.toBeNull()

    act(() => fail!())
    await settle()
    expect(harness.container.querySelector('.ai-sub-blocked')).not.toBeNull()
    expect(harness.requests).toHaveLength(1)
    expect(harness.container.querySelector('.ai-queue-strip')?.getAttribute('data-paused')).toBe(
      'true',
    )
  })

  it('never offers a key provider to continue on', async () => {
    const base = settingsWith('claude-code', { subscriptionNoticeSeen: true })
    harness = await mountPanel({
      settings: {
        ...base,
        providers: { ...base.providers, openai: { apiKey: 'sk-test', model: 'some-model' } },
      },
      subscription: statuses('ready', 'signed-out'),
      answer: (_request, emit) =>
        emit({
          type: 'error',
          error: 'limit reached',
          errorCode: 'rate-limit',
          errorProvider: 'claude-code',
        }),
    })
    await harness.send('summarize this')
    expect(harness.container.querySelector('.ai-sub-blocked')).not.toBeNull()
    expect(harness.container.querySelector('[data-action="continue-with"]')).toBeNull()
  })
})

describe('AI panel: a send while the connection is still being checked', () => {
  it('holds the request and starts it by itself once a provider can run', async () => {
    harness = await mountPanel({
      settings: settingsWith('auto', { subscriptionNoticeSeen: true }),
      subscription: statuses('checking', 'checking'),
      answer: (_request, emit) => {
        emit({ type: 'delta', text: 'hello' })
        emit({ type: 'done' })
      },
    })
    const { container } = harness
    // nobody is waiting on the check yet: no prompt flashes up
    expect(container.querySelector('.ai-sub-prompt')).toBeNull()

    await harness.send('summarize this')
    // held: not sent, not dropped; the cards show the check the request waits for
    expect(harness.requests).toHaveLength(0)
    expect(harness.composerText()).toBe('summarize this')
    expect(container.querySelector('.ai-sub-prompt')).not.toBeNull()
    expect(container.querySelector('.ai-msg-error')).toBeNull()

    await harness.setStatuses(statuses('signed-out', 'ready'))
    expect(harness.requests).toHaveLength(1)
    expect(harness.composerText()).toBe('')
    expect(container.textContent).toContain('hello')
    expect(container.querySelector('.ai-sub-prompt')).toBeNull()
  })

  it('falls to the connect prompt when the answer is "not connected", and sends nothing later', async () => {
    const scrolled = watchScrollIntoView()
    harness = await mountPanel({
      settings: settingsWith('auto', { subscriptionNoticeSeen: true }),
      subscription: statuses('checking', 'checking'),
      answer: (_request, emit) => emit({ type: 'done' }),
    })
    await harness.send('summarize this')

    await harness.setStatuses(statuses('signed-out', 'not-installed'))
    expect(harness.requests).toHaveLength(0)
    const prompt = harness.container.querySelector('.ai-sub-prompt')
    expect(prompt).not.toBeNull()
    expect(scrolled).toContain(prompt)
    expect(harness.composerText()).toBe('summarize this')

    await harness.setStatuses(statuses('ready', 'not-installed'))
    expect(harness.requests).toHaveLength(0)
  })
})

describe('AI panel: first connection notice', () => {
  it('holds the first run on a subscription until the notice is acknowledged', async () => {
    harness = await mountPanel({
      settings: settingsWith('auto'),
      subscription: statuses('ready', 'not-installed'),
      answer: (_request, emit) => {
        emit({ type: 'delta', text: 'hello' })
        emit({ type: 'done' })
      },
    })
    await harness.send('summarize this')
    const { container } = harness
    // nothing left the PC yet
    expect(harness.requests).toHaveLength(0)
    const notice = container.querySelector('.ai-sub-first')
    expect(notice).not.toBeNull()
    // Codex keeps a diagnostic log the app cannot read or prevent: the notice says so here too
    expect(notice?.querySelectorAll('li')).toHaveLength(3)

    act(() => notice!.querySelector<HTMLButtonElement>('button')!.click())
    await settle()
    expect(harness.setAiSettings.mock.calls[0]?.[0]).toMatchObject({ subscriptionNoticeSeen: true })
    expect(harness.requests).toHaveLength(1)
    expect(harness.requests[0]?.settings.subscriptionNoticeSeen).toBe(true)
    expect(container.querySelector('.ai-sub-first')).toBeNull()
    expect(container.textContent).toContain('hello')
  })

  it('sends nothing and keeps the text when the notice goes away without an acknowledgement', async () => {
    harness = await mountPanel({
      settings: settingsWith('auto'),
      subscription: statuses('ready', 'not-installed'),
      answer: (_request, emit) => emit({ type: 'done' }),
    })
    await harness.send('summarize this')
    expect(harness.container.querySelector('.ai-sub-first')).not.toBeNull()

    // the user picks a filled-in key provider instead of answering the notice
    await harness.setSettings(settingsWith('gemini'))
    expect(harness.container.querySelector('.ai-sub-first')).toBeNull()
    expect(harness.requests).toHaveLength(0)
    expect(harness.setAiSettings).not.toHaveBeenCalled()
    expect(harness.composerText()).toBe('summarize this')
  })

  it('writes the acknowledgement over the latest settings file, as complete settings', async () => {
    const panelCopy = settingsWith('auto')
    // another window saved a key after this panel read its copy
    const fileSettings: AiSettings = {
      ...panelCopy,
      providers: { ...panelCopy.providers, openai: { apiKey: 'sk-newer', model: 'some-model' } },
    }
    harness = await mountPanel({
      settings: panelCopy,
      fileSettings,
      subscription: statuses('ready', 'not-installed'),
      answer: (_request, emit) => emit({ type: 'done' }),
    })
    await harness.send('summarize this')
    const ack = harness.container.querySelector<HTMLButtonElement>('.ai-sub-first button')!
    act(() => ack.click())
    await settle()
    expect(harness.setAiSettings).toHaveBeenCalledTimes(1)
    const written = harness.setAiSettings.mock.calls[0]?.[0] as AiSettings
    expect(written.subscriptionNoticeSeen).toBe(true)
    expect(written.providers.openai.apiKey).toBe('sk-newer')
    // a whole settings object, never a one-field patch
    expect(written.provider).toBe('auto')
    expect(Object.keys(written.providers).length).toBe(AI_PROVIDERS.length)
  })

  it('does not ask again once acknowledged, nor for a key provider', async () => {
    harness = await mountPanel({
      settings: settingsWith('auto', { subscriptionNoticeSeen: true }),
      subscription: statuses('ready', 'ready'),
      answer: (_request, emit) => emit({ type: 'done' }),
    })
    await harness.send('summarize this')
    expect(harness.requests).toHaveLength(1)
    expect(harness.container.querySelector('.ai-sub-first')).toBeNull()
    harness.cleanup()

    harness = await mountPanel({
      settings: settingsWith('gemini'),
      subscription: statuses('ready', 'ready'),
      answer: (_request, emit) => emit({ type: 'done' }),
    })
    await harness.send('summarize this')
    expect(harness.requests).toHaveLength(1)
    expect(harness.container.querySelector('.ai-sub-first')).toBeNull()
  })
})

describe('AI panel: entry label', () => {
  it('uses the shared "AI Assistant" label for the panel title and its resizer', async () => {
    harness = await mountPanel({
      settings: settingsWith('gemini'),
      answer: (_request, emit) => emit({ type: 'done' }),
    })
    const title = harness.container.querySelector('.ai-panel-title')!.textContent
    expect(Object.values(AI_SUBSCRIPTION_STRINGS).map((d) => d.aiAssistant)).toContain(title)
    expect(harness.container.querySelector('.ai-panel-resizer')!.getAttribute('aria-label')).toBe(
      title,
    )
  })
})

describe('AI panel: usage and cut input', () => {
  it('shows a usage window at or above the threshold and the cut-input notice', async () => {
    harness = await mountPanel({
      settings: settingsWith('claude-code', { subscriptionNoticeSeen: true }),
      subscription: statuses('ready', 'ready'),
      answer: (_request, emit) => {
        emit({
          type: 'subscription-usage',
          subscriptionUsage: [
            {
              provider: 'claude-code',
              window: 'five_hour',
              utilization: 0.91,
              resetsAt: Date.now() + 3_600_000,
            },
            {
              provider: 'claude-code',
              window: 'seven_day',
              utilization: 0.3,
              resetsAt: Date.now() + 86_400_000,
            },
          ],
        })
        emit({ type: 'input-truncated' })
        emit({ type: 'delta', text: 'ok' })
        emit({ type: 'done' })
      },
    })
    await harness.send('summarize this')
    const { container } = harness
    const usage = container.querySelectorAll('.ai-subscription-usage-item')
    expect(usage).toHaveLength(1)
    expect(usage[0]?.getAttribute('data-window')).toBe('five_hour')
    expect(usage[0]?.textContent).toContain('91')
    expect(container.querySelector('.ai-sub-truncated')).not.toBeNull()
  })

  it('shows nothing while no subscription reports usage', async () => {
    harness = await mountPanel({
      settings: settingsWith('gemini'),
      answer: (_request, emit) => emit({ type: 'done' }),
    })
    await harness.send('summarize this')
    expect(harness.container.querySelector('.ai-subscription-usage')).toBeNull()
    expect(harness.container.querySelector('.ai-sub-truncated')).toBeNull()
  })
})

describe('AI panel: document translation integration', () => {
  it('pins independent batch requests and keeps partial counts and rollback after Stop', async () => {
    const editor = createEditor()
    editor.commands.setContent({
      type: 'doc',
      content: Array.from({ length: 25 }, (_, i) => ({
        type: 'docParagraph',
        content: [{ type: 'text', text: `Source ${i}` }],
      })),
    })
    const original = editor.state.doc.textContent
    const batchReplies: Array<() => void> = []
    let asked = false
    harness = await mountPanel({
      editor,
      settings: settingsWith('gemini'),
      answer: (request, emit) => {
        if (request.tools?.length) {
          if (!asked) {
            asked = true
            emit({
              type: 'tool-call',
              toolCall: {
                id: 'fast',
                name: 'translate_document',
                input: { targetLanguage: 'Korean' },
              },
            })
          } else emit({ type: 'delta', text: 'Complete' })
          emit({ type: 'done' })
        } else {
          const data = JSON.parse((request.messages[0] as { text: string }).text)
          batchReplies.push(() => {
            emit({
              type: 'delta',
              text: JSON.stringify({
                translations: data.units.map((u: { id: string; segments: string[] }) => ({
                  id: u.id,
                  segments: u.segments.map((s) => `Translated ${s}`),
                })),
              }),
            })
            emit({ type: 'done' })
          })
        }
      },
    })
    await harness.send('Translate in place. Keep Acme terminology.')
    expect(harness.requests).toHaveLength(3)
    const batches = harness.requests.slice(1)
    expect(new Set(harness.requests.map((r) => r.requestId)).size).toBe(3)
    expect(batches.every((r) => r.tools?.length === 0 && r.settings?.provider === 'gemini')).toBe(
      true,
    )
    expect(batches.every((r) => r.system.includes('Keep Acme terminology.'))).toBe(true)
    await act(async () => {
      batchReplies[0]()
    })
    await settle()
    expect(editor.state.doc.textContent).toContain('Translated Source 0')
    act(() => harness!.container.querySelector<HTMLButtonElement>('.ai-send-btn')!.click())
    await settle()
    const { t: translate } = await import('../src/renderer/i18n/locale')
    expect(harness.container.textContent).toContain(
      translate('aiTranslationProgress', {
        completed: 12,
        reused: 0,
        failed: 0,
        stale: 0,
        skipped: 0,
        pending: 13,
      }),
    )
    const rollback = harness.container.querySelector<HTMLButtonElement>('.ai-rollback-btn')
    expect(rollback).not.toBeNull()
    const stopped = editor.state.doc.textContent
    await act(async () => {
      batchReplies.slice(1).forEach((reply) => reply())
    })
    await settle()
    expect(editor.state.doc.textContent).toBe(stopped)
    for (const pending of harness.requests.slice(2)) {
      expect(harness.cancelRequests).toHaveBeenCalledWith(pending.requestId)
    }
    act(() => rollback!.click())
    expect(editor.state.doc.textContent).toBe(original)
    expect(harness.setAiSettings).not.toHaveBeenCalled()
  })
})

describe('AI panel: translation scope and blocked batches', () => {
  it('keeps a partial selection captured while the connection gate is checking', async () => {
    const editor = createEditor()
    editor.commands.setTextSelection({ from: 3, to: 7 })
    let asked = false
    harness = await mountPanel({
      editor,
      settings: settingsWith('auto', { subscriptionNoticeSeen: true }),
      subscription: statuses('checking', 'signed-out'),
      answer: (request, emit) => {
        if (!asked) {
          asked = true
          emit({
            type: 'tool-call',
            toolCall: {
              id: 'fast',
              name: 'translate_document',
              input: { targetLanguage: 'Korean' },
            },
          })
        } else emit({ type: 'delta', text: 'Use selection translation.' })
        emit({ type: 'done' })
      },
    })
    await harness.send('Translate this selection in place')
    expect(harness.requests).toHaveLength(0)
    editor.commands.setTextSelection(1)
    await harness.setStatuses(statuses('ready', 'signed-out'))
    expect(harness.requests.length).toBeGreaterThan(0)
    expect(harness.requests.every((request) => !!request.tools?.length)).toBe(true)
    expect(editor.state.doc.textContent).toBe('EVs market research')
  })

  it('stops the parent and both children on a typed blocked batch error', async () => {
    const editor = createEditor()
    editor.commands.setContent({
      type: 'doc',
      content: Array.from({ length: 25 }, (_, i) => ({
        type: 'docParagraph',
        content: [{ type: 'text', text: `Source ${i}` }],
      })),
    })
    const replies: Array<(chunk: Omit<AiStreamChunk, 'requestId'>) => void> = []
    harness = await mountPanel({
      editor,
      settings: settingsWith('auto', { subscriptionNoticeSeen: true }),
      subscription: statuses('ready', 'signed-out'),
      answer: (request, emit) => {
        if (request.tools?.length) {
          emit({
            type: 'tool-call',
            toolCall: {
              id: 'fast',
              name: 'translate_document',
              input: { targetLanguage: 'Korean' },
            },
          })
          emit({ type: 'done' })
        } else replies.push(emit)
      },
    })
    await harness.send('Translate in place')
    expect(harness.requests).toHaveLength(3)
    await act(async () => {
      replies[0]({
        type: 'error',
        error: 'Quota exhausted',
        errorCode: 'rate-limit',
        errorProvider: 'claude-code',
        errorResetsAt: 12345,
      })
    })
    await settle()
    expect(harness.requests).toHaveLength(3)
    expect(harness.container.querySelector('.ai-sub-blocked')).not.toBeNull()
    expect(
      harness.container.querySelector('.ai-message.assistant > div[dir="auto"]')?.textContent ?? '',
    ).not.toBe('已停止')
    expect(
      harness.requests.slice(1).every((request) => request.settings?.provider === 'claude-code'),
    ).toBe(true)
    for (const request of harness.requests.slice(1))
      expect(harness.cancelRequests).toHaveBeenCalledWith(request.requestId)
    expect(harness.setAiSettings).not.toHaveBeenCalled()
  })
})

describe('AI panel: translated note rollback', () => {
  it('restores external note state together with the body rollback snapshot', async () => {
    let notes: import('@genoffice/docx-engine').NoteInfo[] = [
      { id: '1', text: 'Note source', richParas: [[{ text: 'Note source' }]] },
    ]
    const access: import('../src/renderer/ai/note-ops').AiNotesAccess = {
      list: (kind) => (kind === 'footnote' ? notes : []),
      add: () => '',
      remove: () => false,
      replace: (_kind, id, next) => {
        notes = notes.map((note) => (note.id === id ? next : note))
        return true
      },
      restoreSnapshot: (snapshot) => {
        notes = snapshot.footnotes
      },
    }
    let asked = false
    harness = await mountPanel({
      settings: settingsWith('gemini'),
      notesAccess: access,
      answer: (request, emit) => {
        if (request.tools?.length) {
          if (!asked) {
            asked = true
            emit({
              type: 'tool-call',
              toolCall: {
                id: 'fast',
                name: 'translate_document',
                input: { targetLanguage: 'Korean', includeNotes: true },
              },
            })
          } else emit({ type: 'delta', text: 'Translated body and notes.' })
        } else {
          const data = JSON.parse((request.messages[0] as { text: string }).text)
          emit({
            type: 'delta',
            text: JSON.stringify({
              translations: data.units.map((unit: { id: string; segments: string[] }) => ({
                id: unit.id,
                segments: unit.segments.map((text) => `Translated ${text}`),
              })),
            }),
          })
        }
        emit({ type: 'done' })
      },
    })
    await harness.send('Translate document and notes in place')
    expect(notes[0].text).toBe('Translated Note source')
    expect(harness.editor.state.doc.textContent).toContain('Translated EVs')
    const rollback = harness.container.querySelector<HTMLButtonElement>('.ai-rollback-btn')
    expect(rollback).not.toBeNull()
    act(() => rollback!.click())
    expect(notes[0].text).toBe('Note source')
    expect(harness.editor.state.doc.textContent).toBe('EVs market research')
  })
})

describe('AI panel: translation retry scope', () => {
  it('keeps the original full-block selection after Stop even if the live selection moves', async () => {
    const editor = createEditor()
    editor.commands.setContent({
      type: 'doc',
      content: ['First', 'Second'].map((text) => ({
        type: 'docParagraph',
        content: [{ type: 'text', text }],
      })),
    })
    editor.commands.setTextSelection({ from: 1, to: 6 })
    const batches: Array<{ units: Array<{ id: string; segments: string[] }> }> = []
    harness = await mountPanel({
      editor,
      settings: settingsWith('gemini'),
      answer: (request, emit) => {
        if (request.tools?.length) {
          emit({
            type: 'tool-call',
            toolCall: {
              id: `fast-${batches.length}`,
              name: 'translate_document',
              input: { targetLanguage: 'Korean' },
            },
          })
          emit({ type: 'done' })
        } else batches.push(JSON.parse((request.messages[0] as { text: string }).text))
      },
    })
    await harness.send('Translate selected block in place')
    expect(batches[0].units).toHaveLength(1)
    act(() => harness!.container.querySelector<HTMLButtonElement>('.ai-send-btn')!.click())
    await settle()
    editor.commands.setTextSelection(9)
    const { t } = await import('../src/renderer/i18n/locale')
    const retry = Array.from(
      harness.container.querySelectorAll<HTMLButtonElement>('.ai-msg-tool-btn'),
    ).find((button) => button.getAttribute('aria-label') === t('aiRegenerateTitle'))
    expect(retry).toBeDefined()
    act(() => retry!.click())
    await settle()
    expect(batches).toHaveLength(2)
    expect(batches[1].units).toHaveLength(1)
    expect(batches[1].units[0].segments).toEqual(['First'])
  })
})

describe('AI panel: translation outgoing payload sanitation', () => {
  it('does not send an accidentally pasted API key or password in parent or child messages', async () => {
    const apiKey = 'sk-abcdef1234567890abcdef'
    const password = 's3cret-password!'
    harness = await mountPanel({
      settings: settingsWith('gemini'),
      answer: (request, emit) => {
        if (request.tools?.length) {
          emit({
            type: 'tool-call',
            toolCall: {
              id: 'fast',
              name: 'translate_document',
              input: {
                targetLanguage: 'Korean',
                instructions: `password=${password}; keep terminology.`,
              },
            },
          })
          emit({ type: 'done' })
        }
      },
    })
    await harness.send(
      `Translate in place. Accidental key ${apiKey}; password=${password}; use formal style.`,
    )
    expect(harness.requests).toHaveLength(2)
    for (const request of harness.requests) {
      const content = request.system + JSON.stringify(request.messages)
      expect(content).not.toContain(apiKey)
      expect(content).not.toContain(password)
      expect(content).toContain('[REDACTED_API_KEY]')
      expect(content).toContain('[REDACTED_SECURE_TOKEN]')
    }
  })
})

describe('AI panel: translation scope refresh after a document read', () => {
  it('can retry the original scope after compatible external formatting and own translation commits', async () => {
    const editor = createEditor()
    let finishBatch!: () => void
    let turn = 0
    harness = await mountPanel({
      editor,
      settings: settingsWith('gemini'),
      answer: (request, emit) => {
        if (request.tools?.length) {
          const name = turn === 1 ? 'get_document_context' : 'translate_document'
          if (turn < 3)
            emit({
              type: 'tool-call',
              toolCall: {
                id: `refresh-${turn}`,
                name,
                input: name === 'translate_document' ? { targetLanguage: 'Korean' } : {},
              },
            })
          else emit({ type: 'delta', text: 'Done' })
          turn++
          emit({ type: 'done' })
        } else {
          const data = JSON.parse((request.messages[0] as { text: string }).text)
          finishBatch = () => {
            emit({
              type: 'delta',
              text: JSON.stringify({
                translations: data.units.map((unit: { id: string; segments: string[] }) => ({
                  id: unit.id,
                  segments: unit.segments.map((text) => `Translated ${text}`),
                })),
              }),
            })
            emit({ type: 'done' })
          }
        }
      },
    })
    await harness.send('Translate the whole body in place')
    const node = editor.state.doc.child(0)
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(0, undefined, { ...node.attrs, aiChanged: true }),
    )
    await act(async () => finishBatch())
    await settle()
    const replies = harness.requests.flatMap((request) =>
      request.messages.filter((message) => message.role === 'tool'),
    )
    expect(JSON.stringify(replies)).not.toContain('The captured document scope changed')
    expect(editor.state.doc.textContent).toBe('Translated EVs market research')
    expect(turn).toBe(4)
  })
})

describe('AI panel: explicit reads reestablish only the original translation scope', () => {
  it.each(['get_document_context', 'read_runs'])(
    'refreshes after %s without following a moved DOM selection',
    async (readTool) => {
      const editor = createEditor()
      editor.commands.setContent({
        type: 'doc',
        content: ['First', 'Second'].map((text) => ({
          type: 'docParagraph',
          content: [{ type: 'text', text }],
        })),
      })
      editor.commands.setTextSelection({ from: 1, to: 6 })
      let turn = 0
      let batches = 0
      harness = await mountPanel({
        editor,
        settings: settingsWith('gemini'),
        answer: (request, emit) => {
          if (request.tools?.length) {
            if (turn === 1) {
              const first = editor.state.doc.child(0)
              editor.view.dispatch(
                editor.state.tr.setNodeMarkup(0, undefined, { ...first.attrs, aiChanged: true }),
              )
              editor.commands.setTextSelection(editor.state.doc.child(0).nodeSize + 2)
            }
            const name = turn === 1 ? readTool : 'translate_document'
            if (turn < 3)
              emit({
                type: 'tool-call',
                toolCall: {
                  id: `read-${turn}`,
                  name,
                  input:
                    name === 'translate_document'
                      ? { targetLanguage: 'Korean' }
                      : name === 'read_runs'
                        ? { startBlockIndex: 0, endBlockIndex: 0 }
                        : {},
                },
              })
            else emit({ type: 'delta', text: 'Done' })
            turn++
          } else {
            batches++
            const data = JSON.parse((request.messages[0] as { text: string }).text)
            expect(data.units).toHaveLength(1)
            emit({
              type: 'delta',
              text: JSON.stringify({
                translations: data.units.map((unit: { id: string; segments: string[] }) => ({
                  id: unit.id,
                  segments: unit.segments.map((text) => `Translated ${text}`),
                })),
              }),
            })
          }
          emit({ type: 'done' })
        },
      })
      await harness.send('Translate selected block')
      expect(batches).toBe(1)
      expect(turn).toBe(4)
      expect(editor.state.doc.textContent).toBe('Translated FirstSecond')
      const outputs = harness.requests.flatMap((request) =>
        request.messages.filter((message) => message.role === 'tool'),
      )
      expect(JSON.stringify(outputs)).not.toContain('The captured document scope changed')
    },
  )

  it('stops repeated tool attempts when a full replacement destroyed original scope provenance', async () => {
    const editor = createEditor()
    let finishBatch!: () => void
    let turn = 0
    harness = await mountPanel({
      editor,
      settings: settingsWith('gemini'),
      answer: (request, emit) => {
        if (request.tools?.length) {
          if (turn === 1)
            editor.commands.setContent({
              type: 'doc',
              content: [
                {
                  type: 'docParagraph',
                  content: [{ type: 'text', text: 'User replaced document' }],
                },
              ],
            })
          const name = turn === 1 ? 'get_document_context' : 'translate_document'
          emit({
            type: 'tool-call',
            toolCall: {
              id: `blocked-${turn}`,
              name,
              input: name === 'translate_document' ? { targetLanguage: 'Korean' } : {},
            },
          })
          turn++
          emit({ type: 'done' })
        } else {
          const data = JSON.parse((request.messages[0] as { text: string }).text)
          finishBatch = () => {
            emit({
              type: 'delta',
              text: JSON.stringify({
                translations: data.units.map((unit: { id: string; segments: string[] }) => ({
                  id: unit.id,
                  segments: unit.segments.map((text) => `Translated ${text}`),
                })),
              }),
            })
            emit({ type: 'done' })
          }
        }
      },
    })
    await harness.send('Translate body')
    await act(async () => finishBatch())
    await settle()
    expect(turn).toBe(3)
    expect(harness.container.textContent).toContain('new message')
    expect(editor.state.doc.textContent).toBe('User replaced document')
    expect(harness.requests.filter((request) => !request.tools?.length)).toHaveLength(1)
  })
})

describe('AI panel: verified save reload during translation', () => {
  it('keeps the captured range and avoids retry loops after save baseline anchors are refreshed', async () => {
    const { SAVED_DOCUMENT_RELOAD_META } = await import('../src/renderer/save-reload')
    const editor = createEditor()
    editor.commands.setContent({
      type: 'doc',
      content: ['First', 'Second'].map((text) => ({
        type: 'docParagraph',
        content: [{ type: 'text', text }],
      })),
    })
    editor.commands.setTextSelection({ from: 1, to: 6 })
    let finishBatch!: () => void
    let turn = 0
    let batches = 0
    harness = await mountPanel({
      editor,
      settings: settingsWith('gemini'),
      answer: (request, emit) => {
        if (request.tools?.length) {
          if (turn < 2)
            emit({
              type: 'tool-call',
              toolCall: {
                id: `save-${turn}`,
                name: 'translate_document',
                input: { targetLanguage: 'Korean' },
              },
            })
          else emit({ type: 'delta', text: 'Done' })
          turn++
          emit({ type: 'done' })
        } else {
          batches++
          const data = JSON.parse((request.messages[0] as { text: string }).text)
          expect(data.units).toHaveLength(1)
          finishBatch = () => {
            emit({
              type: 'delta',
              text: JSON.stringify({
                translations: data.units.map((unit: { id: string; segments: string[] }) => ({
                  id: unit.id,
                  segments: unit.segments.map((text) => `Translated ${text}`),
                })),
              }),
            })
            emit({ type: 'done' })
          }
        }
      },
    })
    await harness.send('Translate the selected paragraph')
    const before = editor.state.doc
    const normalized = before.toJSON()
    normalized.content.forEach((node: { attrs: Record<string, unknown> }, index: number) => {
      node.attrs = { ...node.attrs, docxIndex: index }
    })
    editor.view.dispatch(
      editor.state.tr
        .replaceWith(0, before.content.size, editor.schema.nodeFromJSON(normalized).content)
        .setMeta(SAVED_DOCUMENT_RELOAD_META, before),
    )
    editor.commands.setTextSelection(editor.state.doc.child(0).nodeSize + 2)
    await act(async () => finishBatch())
    await settle()
    expect(turn).toBe(3)
    expect(batches).toBe(1)
    expect(editor.state.doc.textContent).toBe('Translated FirstSecond')
    const outputs = harness.requests.flatMap((request) =>
      request.messages.filter((message) => message.role === 'tool'),
    )
    expect(JSON.stringify(outputs)).not.toContain('The captured document scope changed')
    expect(harness.container.querySelector('.ai-msg-error')).toBeNull()
  })
})

describe('AI panel: successive translation subranges', () => {
  it.each(['whole body', 'selected blocks'])(
    'keeps the original %s boundary and each completed chip count',
    async (authorization) => {
      const editor = createEditor()
      const texts =
        authorization === 'whole body'
          ? ['First', 'Second', 'Third']
          : ['First', 'Second', 'Third', 'Outside']
      editor.commands.setContent({
        type: 'doc',
        content: texts.map((text) => ({ type: 'docParagraph', content: [{ type: 'text', text }] })),
      })
      if (authorization === 'selected blocks')
        editor.commands.setTextSelection({
          from: 1,
          to:
            editor.state.doc.child(0).nodeSize +
            editor.state.doc.child(1).nodeSize +
            editor.state.doc.child(2).nodeSize -
            1,
        })
      let turn = 0
      const batchSizes: number[] = []
      harness = await mountPanel({
        editor,
        settings: settingsWith('gemini'),
        answer: (request, emit) => {
          if (request.tools?.length) {
            if (turn === 0) {
              for (const [id, startBlockIndex, endBlockIndex] of [
                ['first', 0, 0],
                ['second', 1, 2],
              ] as const)
                emit({
                  type: 'tool-call',
                  toolCall: {
                    id,
                    name: 'translate_document',
                    input: { targetLanguage: 'Korean', startBlockIndex, endBlockIndex },
                  },
                })
            } else if (turn === 1)
              emit({
                type: 'tool-call',
                toolCall: {
                  id: 'original-scope',
                  name: 'translate_document',
                  input: { targetLanguage: 'Korean' },
                },
              })
            else emit({ type: 'delta', text: 'Done' })
            turn++
          } else {
            const data = JSON.parse((request.messages[0] as { text: string }).text)
            batchSizes.push(data.units.length)
            emit({
              type: 'delta',
              text: JSON.stringify({
                translations: data.units.map((unit: { id: string; segments: string[] }) => ({
                  id: unit.id,
                  segments: unit.segments.map((text) => `Translated ${text}`),
                })),
              }),
            })
          }
          emit({ type: 'done' })
        },
      })
      await harness.send(`Translate ${authorization}`)
      expect(batchSizes).toEqual([1, 2])
      expect(turn).toBe(3)
      expect(editor.state.doc.textContent).toBe(
        'Translated FirstTranslated SecondTranslated Third' +
          (authorization === 'selected blocks' ? 'Outside' : ''),
      )
      const { t } = await import('../src/renderer/i18n/locale')
      const summaries = Array.from(
        harness.container.querySelectorAll('.ai-step-title[data-tip="translate_document"]'),
      ).map((element) => element.textContent)
      expect(summaries).toEqual([
        t('aiTranslationProgress', {
          completed: 1,
          reused: 0,
          failed: 0,
          stale: 0,
          skipped: 0,
          pending: 0,
        }),
        t('aiTranslationProgress', {
          completed: 2,
          reused: 0,
          failed: 0,
          stale: 0,
          skipped: 0,
          pending: 0,
        }),
        t('aiTranslationProgress', {
          completed: 0,
          reused: 3,
          failed: 0,
          stale: 0,
          skipped: 0,
          pending: 0,
        }),
      ])
    },
  )
})
