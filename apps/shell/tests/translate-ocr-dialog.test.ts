/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiSettings } from '@genoffice/ai-provider/browser'
import type { SourceEntry } from '@genoffice/translate-project'
import { OcrSelectDialog } from '../src/renderer/src/translate/OcrSelectDialog'
import { LocaleProvider } from '../src/renderer/src/locale'
import type { SubscriptionConnection } from '../src/renderer/src/subscription-client'
import type { OcrAsk, OcrPrepared } from '../src/shared/translate-ocr'

/**
 * The OCR window against a fake bridge and a fake model call (no AI). The
 * locale is English so buttons can be matched by text.
 */

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

const ANSWER = '<page-content>\nText\n</page-content>'
const PDF: SourceEntry = { file: 'scan.pdf', sha256: 'x', kind: 'scan' }

let host: HTMLDivElement
let root: Root
let api: Record<string, ReturnType<typeof vi.fn>>
let ask: ReturnType<typeof vi.fn<OcrAsk>>
let prepared: OcrPrepared

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

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  prepared = {
    token: 'tok',
    kind: 'pdf',
    ocr: { kind: 'ai', provider: 'claude' },
    items: [1, 2, 3].map((index) => ({ index, name: '' })),
  }
  api = {
    ocrPrepare: vi.fn(async () => prepared),
    ocrStart: vi.fn(async () => undefined),
    ocrPageImage: vi.fn(async () => ({ data: new Uint8Array([1]), mime: 'image/png' })),
    ocrPreview: vi.fn(async () => ({ data: new Uint8Array([1, 2, 3]), mime: 'image/png' })),
    ocrWrite: vi.fn(async () => ({ outputPath: '/p/output/scan (OCR).docx' })),
    ocrRelease: vi.fn(async () => undefined),
  }
  ask = vi.fn<OcrAsk>(async () => ANSWER)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function render(
  props: Partial<Parameters<typeof OcrSelectDialog>[0]> = {},
  statuses: SubscriptionConnection['statuses'] = { 'claude-code': { state: 'ready' } as never },
  scopeOnly = false,
) {
  await act(async () => {
    root.render(
      createElement(
        LocaleProvider,
        { initial: 'en' },
        createElement(OcrSelectDialog, {
          dir: '/p',
          sources: [PDF],
          aiSettings: SETTINGS,
          connection: connection(statuses),
          onOpenAiSettings: () => undefined,
          onClose: () => undefined,
          api: api as never,
          makeAsk: () => ask,
          ...props,
        }),
      ),
    )
  })
  if (!scopeOnly && host.querySelector('[data-step="scope"]')) await click(button('Choose items'))
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
}

const boxes = () => [...host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')]

describe('OcrSelectDialog', () => {
  it('shows embedded image names, locations and local previews only in the selection list', async () => {
    prepared.kind = 'embedded'
    prepared.items = [{ index: 1, name: 'menu.png', location: 'Menu · B5' }]
    await render(
      { sources: [{ file: 'menu.xlsx', kind: 'editable', sha256: 'x' }] },
      undefined,
      true,
    )
    expect(api.ocrPreview).not.toHaveBeenCalled()
    await click(button('Choose items'))
    expect(host.textContent).toContain('Menu · B5')
    expect(host.querySelector('img[alt="menu.png"]')?.getAttribute('src')).toBe(
      'data:image/png;base64,AQID',
    )
    expect(api.ocrPreview).toHaveBeenCalledWith({ token: 'tok', index: 1 })
    expect(api.ocrPageImage).not.toHaveBeenCalled()
    expect(ask).not.toHaveBeenCalled()
  })
  it('shows the pictures taken out of a Hangul document like embedded ones, with their numbers and previews', async () => {
    prepared.kind = 'extracted'
    prepared.items = [{ index: 1, name: 'BIN0001.png', location: 'BinData' }]
    await render(
      { sources: [{ file: 'form.hwp', kind: 'editable', sha256: 'x' }] },
      undefined,
      true,
    )
    await click(button('Choose items'))
    expect(host.textContent).toContain('BinData')
    expect(host.querySelector('[data-number="1"]')).not.toBeNull()
    expect(host.querySelector('img[alt="BIN0001.png"]')?.getAttribute('src')).toBe(
      'data:image/png;base64,AQID',
    )
    expect(host.querySelector('[data-action="enlarge"]')).not.toBeNull()
    expect(ask).not.toHaveBeenCalled()
  })

  it('shows the page of each picture, and says when it may be on a later page', async () => {
    prepared.kind = 'embedded'
    prepared.items = [
      { index: 1, name: 'a.png', location: 'document.xml · ¶1', page: 1 },
      { index: 2, name: 'b.png', location: 'document.xml · ¶9', page: 3, pageApprox: true },
      { index: 3, name: 'c.png', location: 'header1.xml · ¶1' },
    ]
    await render(
      { sources: [{ file: 'book.docx', kind: 'editable', sha256: 'x' }] },
      undefined,
      true,
    )
    await click(button('Choose items'))
    const pageOf = (n: number) =>
      host.querySelector(`[data-number="${n}"]`)?.closest('label')?.querySelector('[data-page]')
    expect(pageOf(1)?.textContent).toBe('Page 1')
    expect(pageOf(2)?.textContent).toBe('Page 3 or later')
    expect(pageOf(3)).toBeNull()
  })
  it('asks for the OCR scope before showing the selection list or sending images', async () => {
    await render({}, undefined, true)
    expect(host.querySelector('[data-step="scope"]')).not.toBeNull()
    expect(boxes()).toHaveLength(0)
    expect(button('Read all').disabled).toBe(false)
    await click(button('Choose items'))
    expect(boxes()).toHaveLength(3)
    expect(boxes().every((b) => !b.checked)).toBe(true)
    expect(api.ocrPageImage).not.toHaveBeenCalled()
    expect(ask).not.toHaveBeenCalled()
  })

  it('confirms all items before reading them and allows changing to a subset', async () => {
    await render({}, undefined, true)
    await click(button('Read all'))
    expect(host.textContent).toContain('Pages or files to read: 3')
    expect(ask).not.toHaveBeenCalled()
    expect(api.ocrStart).not.toHaveBeenCalled()
    await click(button('Back'))
    expect(host.querySelector('[data-step="scope"]')).not.toBeNull()
    await click(button('Choose items'))
    await click(boxes()[1]!)
    await click(button('Next'))
    await click(button('Start'))
    expect(api.ocrStart).toHaveBeenCalledWith({ token: 'tok', pages: [2] })
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('reads every listed item only after confirming the whole document', async () => {
    await render({}, undefined, true)
    await click(button('Read all'))
    await click(button('Start'))
    expect(api.ocrStart).toHaveBeenCalledWith({ token: 'tok', pages: [1, 2, 3] })
    expect(ask).toHaveBeenCalledTimes(3)
  })

  it('lists the pages with nothing chosen at first', async () => {
    await render()
    expect(api.ocrPrepare).toHaveBeenCalledWith({ dir: '/p', files: ['scan.pdf'] })
    expect(boxes()).toHaveLength(3)
    expect(boxes().every((b) => !b.checked)).toBe(true)
    expect(host.textContent).toContain('Page 2')
  })

  it('select all checks every page', async () => {
    await render()
    await click(button('Select all'))
    expect(boxes().every((b) => b.checked)).toBe(true)
    expect(host.textContent).toContain('Chosen: 3 of 3')
    await click(button('Clear selection'))
    expect(boxes().every((b) => !b.checked)).toBe(true)
  })

  it('start is disabled with zero selected', async () => {
    await render()
    expect(button('Next').disabled).toBe(true)
    await click(boxes()[1]!)
    expect(button('Next').disabled).toBe(false)
    await click(boxes()[1]!)
    expect(button('Next').disabled).toBe(true)
  })

  it('the confirmation shows the count and the AI, and Back or Cancel sends nothing', async () => {
    const onClose = vi.fn()
    await render({ onClose })
    await click(boxes()[0]!)
    await click(boxes()[2]!)
    await click(button('Next'))
    expect(host.textContent).toContain('Pages or files to read: 2')
    expect(host.querySelector('[data-provider]')?.getAttribute('data-provider')).toBe('claude-code')
    expect(host.textContent).toContain('The chosen page images are sent to this AI.')
    await click(button('Back'))
    expect(boxes()).toHaveLength(3)
    await click(button('Next'))
    await click(button('Cancel'))
    expect(onClose).toHaveBeenCalled()
    expect(api.ocrStart).not.toHaveBeenCalled()
    expect(api.ocrPageImage).not.toHaveBeenCalled()
    expect(ask).not.toHaveBeenCalled()
  })

  it('Start reads only the chosen pages and reports the document', async () => {
    const onFinished = vi.fn()
    await render({ onFinished })
    await click(boxes()[1]!)
    await click(button('Next'))
    await click(button('Start'))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(api.ocrStart).toHaveBeenCalledWith({ token: 'tok', pages: [2] })
    expect(api.ocrPageImage).toHaveBeenCalledWith({ token: 'tok', index: 2 })
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0]![0]).toBe('claude')
    expect(host.textContent).toContain('scan (OCR).docx')
    expect(onFinished).toHaveBeenCalledWith(expect.objectContaining({ read: [2] }))
  })

  it('Start stays disabled while the AI is not connected', async () => {
    await render({}, { 'claude-code': { state: 'signed-out' } as never })
    await click(button('Select all'))
    await click(button('Next'))
    expect(button('Start').disabled).toBe(true)
  })

  it('a paid route says so in the confirmation', async () => {
    await render(
      {
        aiSettings: { ...SETTINGS, meteredAccepted: { 'claude-code': true } } as AiSettings,
      },
      {
        'claude-code': {
          state: 'metered',
          provider: 'claude-code',
          meteredAccepted: true,
        } as never,
      },
    )
    await click(button('Select all'))
    await click(button('Next'))
    expect(host.querySelector('[data-paid]')).not.toBeNull()
  })

  it('an unread first-connection notice asks the home screen and holds the start', async () => {
    const onNoticeNeeded = vi.fn()
    await render({
      onNoticeNeeded,
      aiSettings: { ...SETTINGS, subscriptionNoticeSeen: false, subscriptionNoticeVersion: 0 },
    })
    await click(button('Select all'))
    await click(button('Next'))
    expect(onNoticeNeeded).toHaveBeenCalled()
    expect(button('Start').disabled).toBe(true)
  })

  it('OCR switched off shows the reason and lists nothing', async () => {
    api.ocrPrepare.mockRejectedValue(
      new Error("Error invoking remote method 'translate:ocr-prepare': Error: [OCR_DISABLED] off"),
    )
    await render()
    expect(host.textContent).toContain('OCR is off for this project')
    expect(boxes()).toHaveLength(0)
  })

  it('closing the window releases the listing', async () => {
    await render()
    await act(async () => root.unmount())
    root = createRoot(host)
    expect(api.ocrRelease).toHaveBeenCalledWith('tok')
  })
})

describe('OcrSelectDialog selectOnly (the popup overlay)', () => {
  const XLSX: SourceEntry = { file: 'webtoon.xlsx', kind: 'editable', sha256: 'x' }
  beforeEach(() => {
    prepared = {
      token: 'tok',
      kind: 'embedded',
      format: 'xlsx',
      ocr: { kind: 'ai', provider: 'claude' },
      items: [
        { index: 1, name: 'a.png', location: 'Sheet1 · A7' },
        { index: 2, name: 'b.png', location: 'Sheet1 · A8' },
      ],
    }
    api.ocrRecommend = vi.fn(async () => ({
      placement: { kind: 'xlsx', sheet: 'Sheet1', column: 'B' },
      reason: 'empty-cells',
    }))
  })

  it('says the destination is decided in the chat, not here', async () => {
    await render({ sources: [XLSX], selectOnly: true }, undefined, true)
    await click(button('Choose items'))
    expect(host.textContent).toContain('decided with the AI in the chat')
  })

  it('hands the recognised text and the local recommendation back and never writes or places', async () => {
    const onRecognised = vi.fn()
    const onFinished = vi.fn()
    await render({ sources: [XLSX], selectOnly: true, onRecognised, onFinished }, undefined, true)
    await click(button('Read all'))
    await click(button('Start'))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(onRecognised).toHaveBeenCalledTimes(1)
    const result = onRecognised.mock.calls[0]![0] as {
      pages: { index: number; location: string; text: string }[]
      recommendation: { reason: string }
    }
    expect(result.pages.map((p) => [p.index, p.location, p.text])).toEqual([
      [1, 'Sheet1 · A7', 'Text'],
      [2, 'Sheet1 · A8', 'Text'],
    ])
    expect(result.recommendation.reason).toBe('empty-cells')
    expect(api.ocrWrite).not.toHaveBeenCalled()
    expect(onFinished).not.toHaveBeenCalled()
    expect(host.querySelector('[data-step="place"]')).toBeNull()
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  it('cancelling before the start sends nothing and hands nothing back', async () => {
    const onRecognised = vi.fn()
    const onClose = vi.fn()
    await render({ sources: [XLSX], selectOnly: true, onRecognised, onClose }, undefined, true)
    await click(button('Read all'))
    await click(button('Cancel'))
    expect(onClose).toHaveBeenCalled()
    expect(onRecognised).not.toHaveBeenCalled()
    expect(ask).not.toHaveBeenCalled()
    expect(api.ocrStart).not.toHaveBeenCalled()
    expect(api.ocrWrite).not.toHaveBeenCalled()
  })
})
