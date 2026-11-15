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
import { OCR_BOX_INSTRUCTION } from '../src/shared/ocr-boxes'

/**
 * The picking popup on a Word document: a picture that can take boxes is read as boxes, and the
 * places travel back with its text, so the chat can put the text over the picture.
 */

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

const DOC: SourceEntry = { file: 'book.docx', sha256: 'x', kind: 'editable' } as SourceEntry
const SETTINGS = {
  provider: 'auto',
  providers: {},
  subscriptionNoticeSeen: true,
  subscriptionNoticeVersion: 99,
} as unknown as AiSettings

let host: HTMLDivElement
let root: Root
let api: Record<string, ReturnType<typeof vi.fn>>
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
  const prepared = {
    token: 'tok',
    kind: 'embedded',
    format: 'docx',
    tables: [],
    ocr: { kind: 'ai', provider: 'claude' },
    items: [
      { index: 1, name: 'a.png', location: 'document.xml · ¶2', boxable: true },
      { index: 2, name: 'b.png', location: 'document.xml · ¶9' },
    ],
  } as OcrPrepared
  onRecognised = vi.fn()
  api = {
    ocrPrepare: vi.fn(async () => prepared),
    ocrStart: vi.fn(async () => undefined),
    ocrPageImage: vi.fn(async (args: { index: number }) => ({
      data: new Uint8Array([args.index]),
      mime: 'image/png',
    })),
    ocrPreview: vi.fn(async () => null),
    ocrPreviewLarge: vi.fn(async () => null),
    ocrRecommend: vi.fn(async () => ({
      placement: { kind: 'docx-after-images' },
      reason: 'after-images',
    })),
    ocrRelease: vi.fn(async () => undefined),
  }
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
          sources: [DOC],
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
  await click(button('Start'))
}

const BOX_ANSWER = '<boxes>[{"x":100,"y":200,"w":300,"h":100,"font":80,"text":"Shop name"}]</boxes>'
const PAGE_ANSWER = '<page-content>\nPlain text\n</page-content>'

describe('the picking popup on a Word document', () => {
  it('reads a picture that can take boxes as boxes and the others as plain pages', async () => {
    const systems: string[] = []
    const ask: OcrAsk = async (_p, request) => {
      systems.push(request.system)
      return request.system === OCR_BOX_INSTRUCTION ? BOX_ANSWER : PAGE_ANSWER
    }
    await render(ask)
    await pickAllAndStart()
    expect(systems[0]).toBe(OCR_BOX_INSTRUCTION)
    expect(systems[1]).not.toBe(OCR_BOX_INSTRUCTION)
  })

  it('hands the boxes back with the text of the picture that has them', async () => {
    const ask: OcrAsk = async (_p, request) =>
      request.system === OCR_BOX_INSTRUCTION ? BOX_ANSWER : PAGE_ANSWER
    await render(ask)
    await pickAllAndStart()
    expect(onRecognised).toHaveBeenCalledTimes(1)
    const [first, second] = onRecognised.mock.calls[0]![0].pages
    expect(first).toMatchObject({ index: 1, text: 'Shop name' })
    expect(first!.boxes).toEqual([
      { x: 0.1, y: 0.2, w: 0.3, h: 0.1, fontHeight: 0.08, text: 'Shop name' },
    ])
    expect(second).toMatchObject({ index: 2, text: 'Plain text' })
    expect(second!.boxes).toBeUndefined()
  })

  it('sends no boxes for a picture whose answer had places for none of its text', async () => {
    const ask: OcrAsk = async (_p, request) =>
      request.system === OCR_BOX_INSTRUCTION
        ? '<boxes>[{"text":"No place given"}]</boxes>'
        : PAGE_ANSWER
    await render(ask)
    await pickAllAndStart()
    const [first] = onRecognised.mock.calls[0]![0].pages
    expect(first).toMatchObject({ index: 1, text: 'No place given' })
    expect(first!.boxes).toBeUndefined()
  })
})
