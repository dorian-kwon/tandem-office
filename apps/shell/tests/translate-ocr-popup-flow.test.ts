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
import type { OcrPopupResult } from '../src/shared/ocr-popup'

/**
 * The picking popup (selectOnly) on a workbook with pictures: numbering and enlarging, and what
 * the person sees when a picture gives no text or cannot be read. Fake bridge, fake model call.
 */

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

const SHEET: SourceEntry = { file: 'webtoon.xlsx', sha256: 'x', kind: 'editable' } as SourceEntry
const SETTINGS = {
  provider: 'auto',
  providers: {},
  subscriptionNoticeSeen: true,
  subscriptionNoticeVersion: 99,
} as unknown as AiSettings

const reply = (text: string) => `<page-content>\n${text}\n</page-content>`
/** the picture number the request carried: the fake page image is the single byte [index] */
const indexOf = (request: Parameters<OcrAsk>[1]): number =>
  Buffer.from(request.messages[0]!.images![0]!.base64, 'base64')[0]!

let host: HTMLDivElement
let root: Root
let api: Record<string, ReturnType<typeof vi.fn>>
let prepared: OcrPrepared
let onRecognised: ReturnType<typeof vi.fn<(result: OcrPopupResult) => void>>

function connection(): SubscriptionConnection {
  const noop = () => undefined
  return {
    statuses: { 'claude-code': { state: 'ready' } as never },
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

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  prepared = {
    token: 'tok',
    kind: 'embedded',
    format: 'xlsx',
    ocr: { kind: 'ai', provider: 'claude' },
    items: [
      { index: 1, name: 'image1.jpg', location: 'Webtoon · A7' },
      { index: 2, name: 'image2.jpg', location: 'Webtoon · A82' },
      { index: 3, name: 'image3.jpg', location: 'Webtoon · A157' },
    ],
  } as OcrPrepared
  onRecognised = vi.fn()
  api = {
    ocrPrepare: vi.fn(async () => prepared),
    ocrStart: vi.fn(async () => undefined),
    ocrPageImage: vi.fn(async (_a: unknown) => ({ data: new Uint8Array([1]), mime: 'image/jpeg' })),
    ocrPreview: vi.fn(async () => null),
    ocrPreviewLarge: vi.fn(async () => ({ data: new Uint8Array([9]), mime: 'image/jpeg' })),
    ocrRecommend: vi.fn(async () => ({
      placement: { kind: 'xlsx-new-sheet', sheet: 'OCR' },
      reason: 'new-sheet',
    })),
    ocrRelease: vi.fn(async () => undefined),
  }
  // each picture's bytes are its own number, so the fake model can tell them apart
  api.ocrPageImage!.mockImplementation(async (args: { index: number }) => ({
    data: new Uint8Array([args.index]),
    mime: 'image/jpeg',
  }))
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function render(ask: OcrAsk) {
  await act(async () => {
    root.render(
      createElement(
        LocaleProvider,
        { initial: 'en' },
        createElement(OcrSelectDialog, {
          dir: '/p',
          sources: [SHEET],
          aiSettings: SETTINGS,
          connection: connection(),
          onOpenAiSettings: () => undefined,
          onClose: () => undefined,
          api: api as never,
          makeAsk: () => ask,
          selectOnly: true,
          onRecognised,
        }),
      ),
    )
  })
  await click(button('Preserve original layout'))
}
const button = (text: string): HTMLButtonElement => {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  if (!found) throw new Error(`no button "${text}"`)
  return found
}
const click = async (el: Element) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
const pickAllAndStart = async () => {
  await click(button('Choose items'))
  await click(button('Select all'))
  await click(button('Next'))
  await click(button('Next'))
  await click(button('Start'))
}
const problems = () =>
  [...host.querySelectorAll('[data-problem]')].map((el) => ({
    index: el.getAttribute('data-problem'),
    kind: el.getAttribute('data-kind'),
    text: el.textContent,
  }))

describe('picture list', () => {
  it('numbers the pictures in list order with their sheet and anchor cell', async () => {
    await render(async () => reply('x'))
    await click(button('Choose items'))
    const rows = [...host.querySelectorAll('[data-item]')]
    expect(rows.map((r) => r.getAttribute('data-item'))).toEqual(['1', '2', '3'])
    expect(rows.map((r) => r.querySelector('[data-number]')?.textContent)).toEqual([
      'Picture 1',
      'Picture 2',
      'Picture 3',
    ])
    expect(rows[1]!.textContent).toContain('Webtoon · A82')
  })

  it('enlarges a picture from its row, shows it from the large local preview and Esc closes only the lightbox', async () => {
    await render(async () => reply('x'))
    await click(button('Choose items'))
    await click(host.querySelectorAll('[data-action="enlarge"]')[1]!)
    const box = host.querySelector('[data-lightbox]')!
    expect(box.getAttribute('data-index')).toBe('2')
    expect(api.ocrPreviewLarge).toHaveBeenCalledWith({ token: 'tok', index: 2 })
    // a preview never reads, sends or asks anything
    expect(api.ocrPageImage).not.toHaveBeenCalled()
    expect(api.ocrStart).not.toHaveBeenCalled()
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(host.querySelector('[data-lightbox]')).toBeNull()
    expect(host.querySelector('[data-step="pick"]')).not.toBeNull()
  })
})

describe('what the person sees when recognition gives nothing', () => {
  it('a picture with no text is reported by number and anchor, never as a silent success', async () => {
    const ask: OcrAsk = async (_p, request) =>
      indexOf(request) === 2 ? reply('[FIGURE]') : reply(`text ${indexOf(request)}`)
    await render(ask)
    await pickAllAndStart()
    expect(onRecognised).not.toHaveBeenCalled()
    expect(host.querySelector('[data-review]')?.textContent).toContain(
      'Text was found in 2 of 3 pictures.',
    )
    expect(problems()).toEqual([
      {
        index: '2',
        kind: 'empty',
        text: 'Picture 2 (Webtoon · A82): no text found in this picture.',
      },
    ])
  })

  it('an all-empty run says so for every picture and offers retry, not a bare error', async () => {
    await render(async () => reply('[EMPTY PAGE]'))
    await pickAllAndStart()
    expect(problems().map((p) => p.index)).toEqual(['1', '2', '3'])
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(button('Continue with what was read').disabled).toBe(true)
    expect(onRecognised).not.toHaveBeenCalled()
  })

  it('a failed call is shown with its provider text and no path, and the others are kept', async () => {
    const ask: OcrAsk = async (_p, request) => {
      if (indexOf(request) === 3) throw new Error('child failed at /Users/me/bin/claude: boom')
      return reply(`text ${indexOf(request)}`)
    }
    await render(ask)
    await pickAllAndStart()
    const [only] = problems()
    expect(only).toMatchObject({ index: '3', kind: 'error' })
    expect(only!.text).toContain('could not be read')
    expect(only!.text).toContain('boom')
    expect(only!.text).not.toContain('/Users/')
    await click(button('Continue with what was read'))
    expect(onRecognised).toHaveBeenCalledTimes(1)
    const result = onRecognised.mock.calls[0]![0]
    expect(result.pages.map((p) => p.index)).toEqual([1, 2])
    expect(result.unread).toEqual([{ index: 3, location: 'Webtoon · A157', reason: 'failed' }])
  })

  it('retry reads only the pictures that failed, keeps the earlier text and then hands everything over', async () => {
    let attempt = 0
    const seen: number[] = []
    const ask: OcrAsk = async (_p, request) => {
      const i = indexOf(request)
      seen.push(i)
      if (i === 2 && attempt === 0) return reply('[FIGURE]')
      return reply(`text ${i}`)
    }
    await render(ask)
    await pickAllAndStart()
    expect(problems().map((p) => p.index)).toEqual(['2'])
    attempt = 1
    seen.length = 0
    await click(button('Retry these pictures'))
    // the usual confirmation comes first; nothing is sent before it
    expect(seen).toEqual([])
    expect(host.textContent).toContain('Pages or files to read: 1')
    await click(button('Start'))
    expect(seen).toEqual([2])
    expect(onRecognised).toHaveBeenCalledTimes(1)
    const result = onRecognised.mock.calls[0]![0]
    expect(result.pages.map((p) => [p.index, p.text])).toEqual([
      [1, 'text 1'],
      [2, 'text 2'],
      [3, 'text 3'],
    ])
    expect(result.unread).toBeUndefined()
  })

  it('shows per-picture progress while reading', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const ask: OcrAsk = async (_p, request) => {
      await gate
      return reply(`text ${indexOf(request)}`)
    }
    await render(ask)
    await pickAllAndStart()
    expect(host.querySelector('[data-progress]')?.textContent).toMatch(/Reading… 0 of 3/)
    await act(async () => release())
    expect(onRecognised).toHaveBeenCalledTimes(1)
  })

  it('all pictures with text hand over at once, nothing unread', async () => {
    await render(async (_p, request) => reply(`text ${indexOf(request)}`))
    await pickAllAndStart()
    expect(onRecognised).toHaveBeenCalledTimes(1)
    const result = onRecognised.mock.calls[0]![0]
    expect(result.pages).toHaveLength(3)
    expect(result.unread).toBeUndefined()
    expect(result.recommendation?.reason).toBe('new-sheet')
  })
})
