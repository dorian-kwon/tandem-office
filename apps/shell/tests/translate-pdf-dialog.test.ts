/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiSettings } from '@genoffice/ai-provider/browser'
import type { ProjectFile } from '@genoffice/translate-project'
import {
  buildPdf,
  loadPdfium,
  para,
  wordLines,
} from '../../../packages/pdf-structure/tests/helpers/fixtures'
import { ProjectDetail } from '../src/renderer/src/translate/ProjectDetail'
import type { TranslationSend } from '../../../packages/pdf-structure/src/translate'
import type { DocumentTree } from '../../../packages/pdf-structure/src/tree/types'
import { extractDocumentTree } from '../../../packages/pdf-structure/src/tree'
import { PdfTranslateDialog } from '../src/renderer/src/translate/PdfTranslateDialog'
import { TranslationPanel } from '../src/renderer/src/translate/TranslationPanel'
import {
  homeFirstConnectionShown,
  type HomeNoticePlace,
} from '../src/renderer/src/FirstConnectionNotice'
import { LocaleProvider } from '../src/renderer/src/locale'
import type { SubscriptionConnection } from '../src/renderer/src/subscription-client'
import type { TranslatePdfStoreRequest } from '../src/shared/translate-pdf'

/**
 * The PDF translation window and the translation screen's mounting of the
 * OCR and PDF windows, against a fake bridge and a fake model call (no AI).
 * The locale is English so buttons can be matched by text.
 */

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

let tree: DocumentTree
let bigTree: DocumentTree
let host: HTMLDivElement
let root: Root
let api: Record<string, ReturnType<typeof vi.fn>>
let stored: Array<Record<string, unknown>>
let send: ReturnType<typeof vi.fn<TranslationSend>>

const READY = { 'claude-code': { state: 'ready' } as never }

function connection(statuses: SubscriptionConnection['statuses']): SubscriptionConnection {
  const noop = () => undefined
  return {
    statuses,
    busy: false,
    failed: {},
    codexImageAvailable: false,
    install: noop,
    update: noop,
    cancelLogin: noop,
    login: noop,
    switchAccount: noop,
    logout: noop,
    recheck: noop,
    refresh: noop,
    acceptMetered: async () => undefined,
    openInstallHelp: noop,
    openConnectHelp: noop,
  }
}

const SETTINGS = {
  provider: 'auto',
  providers: {},
  subscriptionNoticeSeen: true,
  subscriptionNoticeVersion: 99,
} as unknown as AiSettings

const UNSEEN = { provider: 'auto', providers: {} } as unknown as AiSettings

function project(patch: Partial<ProjectFile> = {}): ProjectFile {
  return {
    version: 1,
    name: 'Book',
    sourceLang: 'en',
    targetLang: 'de',
    projectPrompt: '',
    ocr: { kind: 'ai', provider: 'claude' },
    sources: [
      { file: 'report.pdf', sha256: 'x', kind: 'pdf' },
      { file: 'scan.pdf', sha256: 'y', kind: 'scan' },
    ],
    references: [],
    glossaryFiles: [],
    ...patch,
  }
}

beforeAll(async () => {
  const bytes = await buildPdf([
    [{ kind: 'text', text: 'The quick brown fox jumps over the lazy dog.', x: 72, y: 700 }],
  ])
  tree = (await extractDocumentTree(bytes, { pdfium: await loadPdfium() } as never)).tree
  const big = await buildPdf(
    Array.from({ length: 10 }, (_, i) => para(wordLines(i * 50, 45), 72, 760)),
  )
  bigTree = (await extractDocumentTree(big, { pdfium: await loadPdfium() } as never)).tree
})

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  stored = []
  send = vi.fn<TranslationSend>(async (request) => {
    const json = request.prompt.split('<document_blocks>\n')[1]!.split('\n</document_blocks>')[0]!
    const data = JSON.parse(json) as { blocks: Array<{ id: string; text: string }> }
    return JSON.stringify({
      translations: data.blocks.map((b) => ({ id: b.id, text: `DE ${b.text}` })),
    })
  })
  api = {
    pdfPrepare: vi.fn(async () => ({ token: 'tok', lang: 'de', docHash: 'h', tree })),
    pdfStore: vi.fn(async ({ request }: { request: TranslatePdfStoreRequest }) => {
      if (request.op === 'read') return { translation: null }
      stored.push(request as unknown as Record<string, unknown>)
      return {}
    }),
    pdfWrite: vi.fn(async ({ bilingual }: { bilingual: boolean }) => ({
      output: bilingual ? 'report.de.bilingual.pdf' : 'report.de.pdf',
    })),
    pdfRelease: vi.fn(async () => undefined),
    instructionsFor: vi.fn(async () => ({
      prompts: 'Be formal.',
      material: 'fox → Fuchs',
      summary: {
        systemPrompt: true,
        projectPrompt: false,
        glossaryTotal: 350,
        glossaryLimit: 200,
        referenceNames: ['style.pdf', 'terms.docx'],
        referenceConverted: 1,
      },
    })),
  }
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  delete (window as unknown as { translateApi?: unknown }).translateApi
})

async function render(
  props: Partial<Parameters<typeof PdfTranslateDialog>[0]> = {},
  statuses: SubscriptionConnection['statuses'] = READY,
) {
  await act(async () => {
    root.render(
      createElement(
        LocaleProvider,
        { initial: 'en' },
        createElement(PdfTranslateDialog, {
          dir: '/p',
          file: 'report.pdf',
          aiSettings: SETTINGS,
          connection: connection(statuses),
          onOpenAiSettings: () => undefined,
          onClose: () => undefined,
          api: api as never,
          makeSend: () => send,
          ...props,
        }),
      ),
    )
  })
  await settle()
}

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)))
}

function button(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  if (!found) throw new Error(`no button "${text}"`)
  return found
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await settle()
}

const dialog = () => host.querySelector('[role="dialog"]')

describe('PdfTranslateDialog', () => {
  it('shows the estimate, the AI and the transfer before anything is sent', async () => {
    await render()
    expect(api.pdfPrepare).toHaveBeenCalledWith({ dir: '/p', file: 'report.pdf' })
    expect(dialog()?.getAttribute('data-step')).toBe('confirm')
    expect(host.querySelector('[data-calls]')?.getAttribute('data-calls')).toBe('1')
    expect(host.querySelector('[data-route="ready"]')?.getAttribute('data-provider')).toBe(
      'claude-code',
    )
    expect(host.textContent).toContain('is sent to this AI')
    expect(send).not.toHaveBeenCalled()
    expect(stored).toEqual([])
    // only the read-only summary call with no request text; nothing went to the AI
    expect(api.instructionsFor.mock.calls).toEqual([[{ dir: '/p', text: '' }]])
  })

  it('the confirmation lists the project context that goes with every request', async () => {
    await render()
    const ctx = host.querySelector('[data-context]')
    expect(ctx).not.toBeNull()
    const text = ctx!.textContent ?? ''
    expect(text).toContain('System prompt for all projects: yes')
    expect(text).toContain('Project prompt: none (empty)')
    expect(text).toContain('350 entries, more than 200')
    expect(text).toContain('Reference files (2): style.pdf, terms.docx')
    expect(text).toContain('parts of their converted text that best match it')
    expect(text).toContain('style.pdf, terms.docx')
    expect(send).not.toHaveBeenCalled()
    expect(stored).toEqual([])
  })

  it('claims no excerpts when no reference has converted text', async () => {
    api.instructionsFor.mockResolvedValue({
      prompts: '',
      material: '',
      references: '',
      summary: {
        systemPrompt: false,
        projectPrompt: true,
        glossaryTotal: 0,
        glossaryLimit: 200,
        referenceNames: ['scan.pdf'],
        referenceConverted: 0,
      },
    })
    await render()
    const text = host.textContent ?? ''
    expect(text).toContain('Reference files (1): scan.pdf. None of them has usable text')
    expect(text).not.toContain('parts of their converted text')
    expect(text).not.toContain('parts of their text that best match')
    expect(host.querySelector('[data-sends-excerpts="false"]')).not.toBeNull()
  })

  it('a small glossary goes whole, and no references says none', async () => {
    api.instructionsFor.mockResolvedValue({
      prompts: '',
      material: '',
      summary: {
        systemPrompt: false,
        projectPrompt: true,
        glossaryTotal: 12,
        glossaryLimit: 200,
        referenceNames: [],
        referenceConverted: 0,
      },
    })
    await render()
    const text = host.querySelector('[data-context]')?.textContent ?? ''
    expect(text).toContain('System prompt for all projects: none (empty)')
    expect(text).toContain('Project prompt: yes')
    expect(text).toContain('Glossary: all 12 entries')
    expect(text).toContain('Reference files: none')
  })

  it('the context stays listed while the job runs', async () => {
    let release!: () => void
    const answer = send.getMockImplementation()!
    send.mockImplementationOnce(
      (request, signal) =>
        new Promise<string>((resolve) => {
          release = () => void answer(request, signal).then(resolve)
        }),
    )
    await render()
    await click(button('Start'))
    expect(dialog()?.getAttribute('data-step')).toBe('running')
    expect(host.querySelector('[data-context]')).not.toBeNull()
    release()
    await settle()
  })

  it('Start runs the job, writes into output/ and opens the result', async () => {
    const onOpenResult = vi.fn()
    await render({ onOpenResult })
    await click(button('Start'))
    expect(send).toHaveBeenCalled()
    // the project's context went with the request
    expect(send.mock.calls[0]![0].system).toContain('Be formal.')
    expect(send.mock.calls[0]![0].system).toContain('fox → Fuchs')
    expect(api.pdfWrite).toHaveBeenCalledWith({ token: 'tok', bilingual: false })
    expect(dialog()?.getAttribute('data-step')).toBe('done')
    expect(onOpenResult).toHaveBeenCalledWith('report.de.pdf')
  })

  it('the bilingual option goes to the writer', async () => {
    await render()
    const box = host.querySelector<HTMLInputElement>('[data-option="bilingual"]')!
    await click(box)
    expect(box.checked).toBe(true)
    await click(button('Start'))
    expect(api.pdfWrite).toHaveBeenCalledWith({ token: 'tok', bilingual: true })
  })

  it('Cancel sends nothing and releases the token', async () => {
    const onClose = vi.fn()
    await render({ onClose })
    await click(button('Cancel'))
    expect(send).not.toHaveBeenCalled()
    expect(stored).toEqual([])
    expect(api.pdfRelease).toHaveBeenCalledWith('tok')
    expect(onClose).toHaveBeenCalled()
  })

  it('Start is disabled while no AI is connected; the connect prompt shows', async () => {
    await render({}, {})
    expect(button('Start').disabled).toBe(true)
    await click(button('Start'))
    expect(send).not.toHaveBeenCalled()
  })

  it('an unread first-connection notice is asked of the home screen and holds Start', async () => {
    const onNoticeNeeded = vi.fn()
    await render({ aiSettings: UNSEEN, onNoticeNeeded })
    expect(onNoticeNeeded).toHaveBeenCalledTimes(1)
    expect(host.querySelector('[data-route="notice"]')).not.toBeNull()
    expect(button('Start').disabled).toBe(true)
  })

  it('a stopped job offers to write what is done', async () => {
    let calls = 0
    send.mockImplementation(async () => {
      calls++
      const err = Object.assign(new Error('limit'), { kind: 'rate-limit' })
      throw err
    })
    await render()
    await click(button('Start'))
    expect(calls).toBeGreaterThan(0)
    expect(dialog()?.getAttribute('data-step')).toBe('stopped')
    expect(api.pdfWrite).not.toHaveBeenCalled()
    // nothing is done, so nothing can be written yet; "later" keeps the store
    expect(host.querySelector('[data-action="write-partial"]')).toBeNull()
    await click(button('Continue later'))
  })
})

describe('PdfTranslateDialog after the review', () => {
  /** the first call answers, every later one hits the usage limit */
  function limitAfterFirst() {
    let calls = 0
    const answer = send.getMockImplementation()!
    send.mockImplementation(async (request, signal) => {
      if (calls++ === 0) return answer(request, signal)
      throw Object.assign(new Error('limit'), { kind: 'rate-limit' })
    })
  }

  it('a stop names its reason in words and offers to write what is done', async () => {
    api.pdfPrepare.mockResolvedValue({ token: 'tok', lang: 'de', docHash: 'h', tree: bigTree })
    limitAfterFirst()
    await render()
    await click(button('Start'))
    expect(dialog()?.getAttribute('data-step')).toBe('stopped')
    const text = host.querySelector('[data-stopped]')!.textContent ?? ''
    expect(host.querySelector('[data-stopped]')?.getAttribute('data-stopped')).toBe('rate-limit')
    // the shared run-error wording, never the raw reason code
    expect(text).not.toContain('rate-limit')
    expect(text.length).toBeGreaterThan(10)
    expect(host.querySelector('[data-action="write-partial"]')).not.toBeNull()
  })

  it('a failed "write what is done" keeps the token until the window releases it', async () => {
    api.pdfPrepare.mockResolvedValue({ token: 'tok', lang: 'de', docHash: 'h', tree: bigTree })
    api.pdfWrite.mockRejectedValue(new Error('[TRANSLATE_FAILED] disk full'))
    limitAfterFirst()
    await render()
    await click(button('Start'))
    await click(host.querySelector('[data-action="write-partial"]')!)
    expect(api.pdfWrite).toHaveBeenCalledWith({ token: 'tok', bilingual: false })
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('could not be completed')
    expect(api.pdfRelease).not.toHaveBeenCalled()
    act(() => root.unmount())
    expect(api.pdfRelease).toHaveBeenCalledWith('tok')
    root = createRoot(host)
  })

  it('leaving the screen while it runs stops the job and frees the token', async () => {
    let seen: AbortSignal | null = null
    send.mockImplementation(
      (_request, signal) =>
        new Promise<string>((_resolve, reject) => {
          seen = signal
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    )
    await render()
    await click(button('Start'))
    expect(dialog()?.getAttribute('data-step')).toBe('running')
    expect(seen).not.toBeNull()
    act(() => root.unmount())
    await settle()
    expect(seen!.aborted).toBe(true)
    expect(api.pdfRelease).toHaveBeenCalledWith('tok')
    root = createRoot(host)
  })

  /**
   * A store that holds the first `count` blocks of `of` (until a restart
   * clears it); the writes are recorded in `stored`.
   */
  async function storeHolding(of: DocumentTree, count: number | 'all') {
    const { translationUnits } = await import('../../../packages/pdf-structure/src/translate')
    const { translationBlockKeys } = await import('../../../packages/pdf-structure/src/store/keys')
    const keys = translationBlockKeys(translationUnits(of))
    const held = count === 'all' ? keys : keys.slice(0, count)
    let cleared = false
    api.pdfPrepare.mockResolvedValue({ token: 'tok', lang: 'de', docHash: 'h', tree: of })
    api.pdfStore.mockImplementation(async ({ request }: { request: TranslatePdfStoreRequest }) => {
      if (request.op === 'read')
        return {
          translation: cleared
            ? null
            : {
                lang: 'de',
                provider: 'claude-code',
                model: '',
                blocks: held.map((key) => ({ key, status: 'translated', text: 'old', savedAt: 1 })),
              },
        }
      stored.push(request as unknown as Record<string, unknown>)
      if (request.op === 'delete-except-edited') cleared = true
      return request.op === 'delete-except-edited' ? { removed: held.length } : {}
    })
    return { total: keys.length, held: held.length }
  }

  const callsShown = () => Number(host.querySelector('[data-calls]')?.getAttribute('data-calls'))

  it('stored progress with blocks left offers Continue (first) and Translate again', async () => {
    const { total, held } = await storeHolding(bigTree, 2)
    await render({ existing: 'report.de.pdf' })
    expect(dialog()?.getAttribute('data-step')).toBe('choose')
    expect(host.querySelector('[data-progress-stored]')?.getAttribute('data-progress-stored')).toBe(
      `${held}/${total}`,
    )
    const cont = host.querySelector<HTMLButtonElement>('[data-action="continue"]')!
    expect(cont.className).toContain('btn-primary')
    expect(cont.textContent).toContain(`${total - held} blocks left`)
    expect(host.querySelector('[data-action="again"]')).not.toBeNull()
    expect(host.querySelector('[data-action="open-existing"]')).not.toBeNull()
    expect(send).not.toHaveBeenCalled()
    expect(stored).toEqual([])
  })

  it('Continue confirms the blocks left and sends only those', async () => {
    const { total, held } = await storeHolding(bigTree, 2)
    await render({ existing: 'report.de.pdf' })
    await click(host.querySelector('[data-action="continue"]')!)
    expect(dialog()?.getAttribute('data-step')).toBe('confirm')
    expect(host.querySelector('[data-restart]')).toBeNull()
    expect(host.querySelector('[data-done-before]')?.getAttribute('data-done-before')).toBe(
      String(held),
    )
    const calls = callsShown()
    expect(send).not.toHaveBeenCalled()
    await click(button('Start'))
    expect(stored.some((r) => r.op === 'delete-except-edited')).toBe(false)
    expect(send).toHaveBeenCalledTimes(calls)
    const sentBlocks = send.mock.calls.reduce((n, [request]) => {
      const json = request.prompt.split('<document_blocks>\n')[1]!.split('\n</document_blocks>')[0]!
      return n + (JSON.parse(json) as { blocks: unknown[] }).blocks.length
    }, 0)
    expect(sentBlocks).toBe(total - held)
  })

  it('Translate again confirms that everything is sent again, then restarts', async () => {
    await storeHolding(bigTree, 2)
    await render({ existing: 'report.de.pdf' })
    const resumeCalls = await (async () => {
      await click(host.querySelector('[data-action="continue"]')!)
      const n = callsShown()
      await click(button('Cancel'))
      return n
    })()
    expect(resumeCalls).toBeGreaterThan(0)
    act(() => root.unmount())
    root = createRoot(host)
    stored = []
    await render({ existing: 'report.de.pdf' })
    await click(host.querySelector('[data-action="again"]')!)
    expect(dialog()?.getAttribute('data-step')).toBe('confirm')
    expect(host.querySelector('[data-restart]')).not.toBeNull()
    const restartCalls = callsShown()
    expect(restartCalls).toBeGreaterThan(resumeCalls)
    expect(send).not.toHaveBeenCalled()
    expect(stored).toEqual([])
    await click(button('Start'))
    expect(stored[0]).toEqual({ op: 'delete-except-edited' })
    expect(send).toHaveBeenCalledTimes(restartCalls)
  })

  it('all done: only Translate again and Open it; opening sends nothing', async () => {
    await storeHolding(tree, 'all')
    const onOpenResult = vi.fn()
    const onClose = vi.fn()
    await render({ existing: 'report.de.pdf', onOpenResult, onClose })
    expect(host.querySelector('[data-action="continue"]')).toBeNull()
    expect(host.querySelector('[data-action="again"]')).not.toBeNull()
    await click(host.querySelector('[data-action="open-existing"]')!)
    expect(onOpenResult).toHaveBeenCalledWith('report.de.pdf')
    expect(onClose).toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(stored).toEqual([])
    expect(api.pdfRelease).toHaveBeenCalledWith('tok')
  })

  it('says which AI is used and what goes with the text', async () => {
    await render()
    expect(host.querySelector('[data-hint="app-ai"]')?.textContent).toContain('AI to use')
    expect(host.textContent).toContain(
      'the names of the reference files and the parts of their text that best match each request',
    )
  })
})

describe('ProjectDetail PDF kind', () => {
  it('a PDF source can be switched between text PDF and scan', async () => {
    const setSourceKind = vi.fn(async ({ kind }: { kind: 'pdf' | 'scan' }) =>
      project({
        sources: [
          { file: 'report.pdf', sha256: 'x', kind },
          { file: 'scan.pdf', sha256: 'y', kind: 'scan' },
        ],
      }),
    )
    ;(window as unknown as { translateApi: unknown }).translateApi = {
      ...api,
      getProject: vi.fn(async () => project()),
      referenceStatus: vi.fn(async () => ({})),
      setSourceKind,
    }
    await act(async () => {
      root.render(
        createElement(
          LocaleProvider,
          { initial: 'en' },
          createElement(ProjectDetail, {
            dir: '/p/a',
            onBack: () => undefined,
            onStartTranslation: () => undefined,
          }),
        ),
      )
    })
    await settle()
    const kinds = [...host.querySelectorAll('[data-source-kind]')].map((el) =>
      el.getAttribute('data-source-kind'),
    )
    expect(kinds).toEqual(['pdf', 'scan'])
    await click(button('Treat as scanned PDF'))
    expect(setSourceKind).toHaveBeenCalledWith({ dir: '/p/a', file: 'report.pdf', kind: 'scan' })
    expect(host.querySelectorAll('[data-source-kind="scan"]')).toHaveLength(2)
    expect(host.querySelectorAll('[data-action="toggle-pdf-kind"]')).toHaveLength(2)
  })
})

describe('TranslationPanel mounting', () => {
  async function renderPanel(props: Record<string, unknown> = {}) {
    ;(window as unknown as { translateApi: unknown }).translateApi = {
      ...api,
      recent: vi.fn(async () => []),
      list: vi.fn(async () => [
        {
          dir: '/p/a',
          name: 'A',
          status: 'ok',
          sourceLang: 'en',
          targetLang: 'de',
          lastOpened: 1,
        },
      ]),
      getProject: vi.fn(async () => project()),
      referenceStatus: vi.fn(async () => ({})),
      getSystemPrompt: vi.fn(async () => ''),
      openTranslation: openTranslationMock,
      openResult: openResultMock,
      ocrPrepare: vi.fn(async () => ({
        token: 'o',
        kind: 'pdf',
        ocr: { kind: 'ai', provider: 'claude' },
        items: [{ index: 1, name: '' }],
      })),
      ocrRelease: vi.fn(async () => undefined),
    }
    await act(async () => {
      root.render(
        createElement(
          LocaleProvider,
          { initial: 'en' },
          createElement(TranslationPanel, {
            aiSettings: SETTINGS,
            connection: connection(READY),
            onOpenAiSettings: () => undefined,
            ...props,
          }),
        ),
      )
    })
    await settle()
    await click(host.querySelector('.translate-open')!)
  }

  let openTranslationMock: ReturnType<typeof vi.fn>
  let openResultMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    openResultMock = vi.fn(async () => ({ sourceTabId: 't1', outputTabId: 't2' }))
  })

  async function openRow(file: string) {
    const row = [...host.querySelectorAll('li, tr')].find((el) => el.textContent?.includes(file))
    const open = [...(row?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent?.trim() === 'Open translation',
    )
    if (!open) throw new Error(`no open button for ${file}`)
    await click(open)
  }

  it('a text PDF mounts the PDF translation window', async () => {
    openTranslationMock = vi.fn(async () => ({
      flow: 'translate-pdf',
      file: 'report.pdf',
      hashStatus: 'ok',
      existing: null,
    }))
    await renderPanel()
    await openRow('report.pdf')
    expect(dialog()?.classList.contains('translate-pdf')).toBe(true)
    expect(api.pdfPrepare).toHaveBeenCalledWith({ dir: '/p/a', file: 'report.pdf' })
  })

  it('a scan mounts the OCR window and opens its document beside the source', async () => {
    openTranslationMock = vi.fn(async () => ({
      flow: 'ocr',
      kind: 'scan',
      file: 'scan.pdf',
      hashStatus: 'ok',
      existing: null,
    }))
    await renderPanel()
    await openRow('scan.pdf')
    expect(dialog()?.classList.contains('translate-ocr')).toBe(true)
    expect(dialog()?.classList.contains('translate-pdf')).toBe(false)
    const prepare = (
      window as unknown as { translateApi: { ocrPrepare: ReturnType<typeof vi.fn> } }
    ).translateApi.ocrPrepare
    expect(prepare).toHaveBeenCalledWith({ dir: '/p/a', files: ['scan.pdf'] })
  })

  it('an earlier result can be opened instead of paying again', async () => {
    openTranslationMock = vi.fn(async () => ({
      flow: 'ocr',
      kind: 'scan',
      file: 'scan.pdf',
      hashStatus: 'ok',
      existing: 'scan (OCR).docx',
    }))
    await renderPanel()
    await openRow('scan.pdf')
    expect(host.querySelector('[data-existing]')?.getAttribute('data-existing')).toBe(
      'scan (OCR).docx',
    )
    await click(button('Open it'))
    expect(openResultMock).toHaveBeenCalledWith({
      dir: '/p/a',
      file: 'scan.pdf',
      output: 'scan (OCR).docx',
    })
    expect(dialog()).toBeNull()
  })

  it('a PDF with an earlier result opens the window at its choice', async () => {
    openTranslationMock = vi.fn(async () => ({
      flow: 'translate-pdf',
      file: 'report.pdf',
      hashStatus: 'ok',
      existing: 'report.de.pdf',
    }))
    await renderPanel()
    await openRow('report.pdf')
    // the PDF window makes the choice itself, from the engine's estimate
    expect(dialog()?.classList.contains('translate-pdf')).toBe(true)
    expect(dialog()?.getAttribute('data-step')).toBe('choose')
    expect(host.querySelector('[data-existing]')?.getAttribute('data-existing')).toBe(
      'report.de.pdf',
    )
    await click(host.querySelector('[data-action="again"]')!)
    expect(host.querySelector('[data-restart]')).not.toBeNull()
  })

  it('OCR switched off shows the localized reason and mounts nothing', async () => {
    openTranslationMock = vi.fn(async () => {
      throw new Error(
        "Error invoking remote method 'translate:open-translation': Error: [OCR_DISABLED] off",
      )
    })
    await renderPanel()
    await openRow('scan.pdf')
    expect(dialog()).toBeNull()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('OCR is off')
  })

  it('a window that needs the first-connection notice asks the home screen', async () => {
    openTranslationMock = vi.fn(async () => ({
      flow: 'translate-pdf',
      file: 'report.pdf',
      hashStatus: 'ok',
      existing: null,
    }))
    const onNoticeNeeded = vi.fn()
    await renderPanel({ aiSettings: UNSEEN, onNoticeNeeded })
    await openRow('report.pdf')
    expect(onNoticeNeeded).toHaveBeenCalledTimes(1)
  })
})

describe('the home screen’s first-connection notice', () => {
  const base: HomeNoticePlace = {
    noticeDue: true,
    settingsVisited: false,
    askMode: false,
    projectsMode: false,
    projectsNoticeAsked: false,
    translateMode: false,
    translateNoticeAsked: false,
  }

  it('shows on the translation screen once one of its windows asked', () => {
    expect(homeFirstConnectionShown({ ...base, translateMode: true })).toBe(false)
    expect(
      homeFirstConnectionShown({ ...base, translateMode: true, translateNoticeAsked: true }),
    ).toBe(true)
    // not on another screen, and never when nothing is due
    expect(homeFirstConnectionShown({ ...base, translateNoticeAsked: true })).toBe(false)
    expect(
      homeFirstConnectionShown({
        ...base,
        noticeDue: false,
        translateMode: true,
        translateNoticeAsked: true,
      }),
    ).toBe(false)
  })

  it('keeps the earlier places', () => {
    expect(homeFirstConnectionShown({ ...base, askMode: true })).toBe(true)
    expect(homeFirstConnectionShown({ ...base, settingsVisited: true })).toBe(true)
    expect(
      homeFirstConnectionShown({ ...base, projectsMode: true, projectsNoticeAsked: true }),
    ).toBe(true)
  })

  it('Home passes the AI settings, the connection and the notice request down', () => {
    const home = readFileSync(join(__dirname, '../src/renderer/src/Home.tsx'), 'utf8')
    const panel = home.slice(
      home.indexOf('<TranslationPanel'),
      home.indexOf('/>', home.indexOf('<TranslationPanel')),
    )
    expect(panel).toContain('aiSettings={aiSettings}')
    expect(panel).toContain('connection={connection}')
    expect(panel).toContain('onNoticeNeeded={() => setTranslateNoticeAsked(true)}')
    expect(home).toContain('translateNoticeAsked,')
  })
})
