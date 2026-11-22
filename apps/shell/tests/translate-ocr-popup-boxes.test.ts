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
import { checkOcrPopupResult, type OcrPopupResult } from '../src/shared/ocr-popup'
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
    tables: [{ index: 1, rows: 4, columns: 3 }],
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
    ocrWrite: vi.fn(async () => ({ outputPath: '/p/output/book (OCR).docx' })),
    ocrRelease: vi.fn(async () => undefined),
  }
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function render(ask: OcrAsk, selectOnly = true, keepFormatting = true) {
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
          selectOnly,
          onRecognised,
        }),
      ),
    )
  })
  expect(host.querySelector('[data-step="format"]')).not.toBeNull()
  expect(host.querySelector('[data-testid="ocr-picture-placement"]')).toBeNull()
  expect(host.querySelector('[data-action="start"]')).toBeNull()
  await click(button(keepFormatting ? 'Preserve original layout' : 'No, insert plain text'))
}
const destination = (kind: string) =>
  host.querySelector<HTMLButtonElement>(`[data-destination="${kind}"]`)!
const button = (text: string): HTMLButtonElement => {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  if (!found) throw new Error(`no button "${text}"`)
  return found
}
const click = async (el: Element) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
const set = async (el: HTMLInputElement | HTMLSelectElement, value: string) =>
  act(async () => {
    const select = el instanceof HTMLSelectElement
    const proto = select ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event(select ? 'change' : 'input', { bubbles: true }))
  })
const pickAllAndStart = async () => {
  await click(button('Choose items'))
  await click(button('Select all'))
  await click(button('Next'))
  await click(button('Next'))
  await click(button('Start'))
}

const BOX_ANSWER = '<boxes>[{"x":100,"y":200,"w":300,"h":100,"font":80,"text":"Shop name"}]</boxes>'
const PAGE_ANSWER = '<page-content>\nPlain text\n</page-content>'

describe('the picking popup on a Word document', () => {
  it.each([true, false])(
    'delivers or writes plain text after separate format and destination choices (chat %s)',
    async (selectOnly) => {
      const ask = vi.fn<OcrAsk>(
        async () =>
          '<page-content>\n<table><tr><td>First</td><td>Second</td></tr></table>\n</page-content>',
      )
      await render(ask, selectOnly, false)
      await click(button('Read all'))
      expect(host.querySelector('[data-step="placement"]')).not.toBeNull()
      expect(host.querySelector('[data-action="start"]')).toBeNull()
      expect(destination('docx-image-boxes')).toBeNull()
      await click(button('Next'))
      expect(host.querySelector('[data-testid="ocr-picture-placement"]')).toBeNull()
      expect(ask).not.toHaveBeenCalled()
      await click(button('Start'))
      if (selectOnly) {
        const page = onRecognised.mock.calls[0]![0].pages[0]!
        expect(page.text).toContain('First')
        expect(page.text).toContain('Second')
        expect(page.form).toBeUndefined()
        expect(page.boxes).toBeUndefined()
      } else {
        expect(api.ocrWrite).toHaveBeenCalledWith(
          expect.objectContaining({
            pages: expect.arrayContaining([
              expect.objectContaining({
                payload: expect.objectContaining({
                  blocks: [expect.objectContaining({ kind: 'paragraph' })],
                }),
              }),
            ]),
          }),
        )
      }
    },
  )
  it.each([
    [true, 'docx-replace-images'],
    [true, 'docx-after-images'],
    [false, 'docx-replace-images'],
    [false, 'docx-after-images'],
  ] as const)(
    'honors the placement selected before reading (chat=%s, placement=%s)',
    async (selectOnly, placement) => {
      const table =
        '<table><tr><th>City</th><th>Count</th></tr><tr><td>Busan</td><td>483</td></tr></table>'
      const ask = vi.fn<OcrAsk>(async (_p, request) =>
        request.system === OCR_BOX_INSTRUCTION
          ? BOX_ANSWER
          : `<page-content>\n${table}\n</page-content>`,
      )
      await render(ask, selectOnly)
      await click(button('Choose items'))
      await click(button('Select all'))
      await click(button('Next'))
      await click(destination(placement))
      expect(ask).not.toHaveBeenCalled()
      expect(api.ocrWrite).not.toHaveBeenCalled()
      await click(button('Next'))
      await click(button('Start'))
      expect(ask).toHaveBeenCalledTimes(2)
      const blocks = [
        expect.objectContaining({
          kind: 'table',
          table: expect.objectContaining({ rowCount: 2, colCount: 2 }),
        }),
      ]
      if (selectOnly) {
        expect(checkOcrPopupResult(onRecognised.mock.calls[0]![0]).pages[0]?.form?.blocks).toEqual(
          blocks,
        )
        expect(onRecognised).toHaveBeenCalledWith(
          expect.objectContaining({ picturePlacement: placement }),
        )
        expect(api.ocrWrite).not.toHaveBeenCalled()
      } else {
        expect(api.ocrWrite).toHaveBeenCalledWith(
          expect.objectContaining({
            placement: { kind: placement },
            pages: expect.arrayContaining([
              expect.objectContaining({ index: 1, payload: expect.objectContaining({ blocks }) }),
            ]),
          }),
        )
      }
    },
  )

  it.each([
    ['그림 앞에 넣어줘', { kind: 'docx-before-images' }],
    ['다음 페이지', { kind: 'docx-next-page' }],
    ['표 1의 2행 3열', { kind: 'docx-table-cell', table: 1, row: 2, column: 3, overwrite: false }],
  ] as const)(
    'checks the typed destination %s before recognition and retains it',
    async (input, expected) => {
      const ask = vi.fn<OcrAsk>(async () => PAGE_ANSWER)
      await render(ask)
      await click(button('Read all'))
      const field = host.querySelector<HTMLInputElement>('[data-testid="ocr-destination-input"]')!
      expect(host.querySelector('[data-testid="ocr-picture-placement"]')).toBeNull()
      expect(host.querySelector('aside')).toBeNull()
      expect(destination('docx-before-images').closest('details')).toBeNull()
      expect(destination('docx-next-page').closest('details')).toBeNull()
      expect(destination('docx-end').closest('details')?.open).toBe(false)
      await set(field, '표 1의 2행 4열')
      expect(button('Next').disabled).toBe(true)
      await set(field, '다음 페이지 또는 문서 끝')
      expect(button('Next').disabled).toBe(true)
      await set(field, input)
      expect(button('Next').disabled).toBe(false)
      expect(ask).not.toHaveBeenCalled()
      await click(button('Next'))
      await click(button('Start'))
      expect(checkOcrPopupResult(onRecognised.mock.calls[0]![0]).placement).toEqual(expected)
    },
  )

  it('does not offer a new page inside a repeating header and lets the person pick a supported alternative', async () => {
    const fixture = await api.ocrPrepare!()
    api.ocrPrepare!.mockResolvedValue({
      ...fixture,
      items: [{ index: 1, name: 'head.png', location: 'header1.xml · ¶1' }],
    })
    const ask = vi.fn<OcrAsk>(async () => PAGE_ANSWER)
    await render(ask)
    await click(button('Read all'))
    expect(destination('docx-next-page').disabled).toBe(true)
    await set(
      host.querySelector<HTMLInputElement>('[data-testid="ocr-destination-input"]')!,
      '다음 페이지',
    )
    expect(button('Next').disabled).toBe(true)
    await click(destination('docx-before-images'))
    expect(button('Next').disabled).toBe(false)
    await click(button('Next'))
    await click(button('Start'))
    expect(onRecognised.mock.calls[0]![0].placement).toEqual({ kind: 'docx-before-images' })
  })

  it('validates a typed sheet and cell, with no implicit overwrite', async () => {
    const fixture = await api.ocrPrepare!()
    api.ocrPrepare!.mockResolvedValue({
      ...fixture,
      format: 'xlsx',
      sheets: ['원본', 'Report 2026'],
    })
    await render(async () => PAGE_ANSWER)
    await click(button('Read all'))
    const field = host.querySelector<HTMLInputElement>('[data-testid="ocr-destination-input"]')!
    await set(field, 'B4')
    expect(button('Next').disabled).toBe(true)
    await set(field, 'Report 2026!XFE1')
    expect(button('Next').disabled).toBe(true)
    await set(field, "'Report 2026'!B4")
    expect(button('Next').disabled).toBe(false)
    await click(button('Next'))
    await click(button('Start'))
    expect(checkOcrPopupResult(onRecognised.mock.calls[0]![0]).placement).toEqual({
      kind: 'xlsx-cells',
      sheet: 'Report 2026',
      cell: 'B4',
      overwrite: false,
    })
  })

  it('requires a valid starting Word cell before the first image is sent and returns that exact location', async () => {
    const ask = vi.fn<OcrAsk>(async () => PAGE_ANSWER)
    await render(ask)
    await click(button('Choose items'))
    await click(button('Select all'))
    await click(button('Next'))
    await click(host.querySelector('details > summary')!)
    await click(destination('docx-table-cell'))
    expect(button('Next').disabled).toBe(true)
    const [table] = host.querySelectorAll<HTMLSelectElement>('select:not([data-testid])')
    const [row, col] = host.querySelectorAll<HTMLInputElement>('input[type=number]')
    await set(table!, '1')
    await set(row!, '4')
    await set(col!, '2')
    expect(button('Next').disabled).toBe(true)
    await set(row!, '2')
    expect(button('Next').disabled).toBe(false)
    expect(ask).not.toHaveBeenCalled()
    await click(button('Next'))
    await click(button('Start'))
    expect(checkOcrPopupResult(onRecognised.mock.calls[0]![0]).placement).toEqual({
      kind: 'docx-table-cell',
      table: 1,
      row: 2,
      column: 2,
      overwrite: false,
    })
  })

  it.each(['pdf', 'extracted'] as const)(
    'delivers the %s reading for a new Word file without writing a private project output',
    async (kind) => {
      const original = await api.ocrPrepare!()
      api.ocrPrepare!.mockResolvedValue({
        ...original,
        kind,
        format: kind === 'pdf' ? 'pdf' : 'hwpx',
      })
      await render(async () => PAGE_ANSWER)
      await pickAllAndStart()
      const result = checkOcrPopupResult(onRecognised.mock.calls[0]![0])
      expect(result.newDocument).toBe(true)
      expect(result.pages[0]?.form?.blocks).toHaveLength(1)
      expect(api.ocrWrite).not.toHaveBeenCalled()
    },
  )

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
