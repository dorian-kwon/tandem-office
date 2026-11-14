/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { LocaleProvider } from '../src/renderer/src/locale'
import { OcrPlacementDialog } from '../src/renderer/src/translate/OcrPlacementDialog'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let cleanup = () => {}
afterEach(() => cleanup())
it('requires an explicit Excel sheet and cell after previewing OCR, leaving replacement off', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  cleanup = () => {
    act(() => root.unmount())
    host.remove()
  }
  const onPlace = vi.fn()
  await act(async () =>
    root.render(
      createElement(
        LocaleProvider,
        { initial: 'en' },
        createElement(OcrPlacementDialog, {
          prepared: {
            token: 't',
            kind: 'embedded',
            format: 'xlsx',
            ocr: { kind: 'ai', provider: 'claude' },
            sheets: ['Original'],
            items: [{ index: 1, name: 'a.png' }],
          },
          pages: [{ index: 1, payload: { blocks: [{ runs: [{ text: 'Recognised text' }] }] } }],
          busy: false,
          onPlace,
          onCancel: vi.fn(),
        }),
      ),
    ),
  )
  expect(host.textContent).toContain('Recognised text')
  const save = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Save here')!
  expect(save.disabled).toBe(true)
  expect(onPlace).not.toHaveBeenCalled()
  const selects = host.querySelectorAll('select')
  await act(async () => {
    selects[0]!.value = 'xlsx-cells'
    selects[0]!.dispatchEvent(new Event('change', { bubbles: true }))
  })
  const sheet = host.querySelectorAll('select')[1]!
  await act(async () => {
    sheet.value = 'Original'
    sheet.dispatchEvent(new Event('change', { bubbles: true }))
  })
  const cell = host.querySelector('input:not([type=checkbox])') as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(cell, 'C7')
    cell.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => save.click())
  expect(onPlace).toHaveBeenCalledWith({
    kind: 'xlsx-cells',
    sheet: 'Original',
    cell: 'C7',
    overwrite: false,
  })
})

it('shows a recommendation and waits for explicit confirmation before applying it', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  cleanup = () => {
    act(() => root.unmount())
    host.remove()
  }
  const onPlace = vi.fn()
  await act(async () =>
    root.render(
      createElement(
        LocaleProvider,
        { initial: 'en' },
        createElement(OcrPlacementDialog, {
          prepared: {
            token: 't',
            kind: 'embedded',
            format: 'xlsx',
            ocr: { kind: 'ai', provider: 'claude' },
            sheets: ['Original'],
            items: [{ index: 1, name: 'a.png' }],
          },
          pages: [{ index: 1, payload: {} }],
          recommendation: {
            placement: { kind: 'xlsx-cells', sheet: 'Original', cell: 'C7', overwrite: false },
            reason: 'empty-cells',
          },
          busy: false,
          onPlace,
          onCancel: vi.fn(),
        }),
      ),
    ),
  )
  expect(host.textContent).toContain('Recommended destination: Original · C7')
  expect(onPlace).not.toHaveBeenCalled()
  await act(async () =>
    [...host.querySelectorAll('button')]
      .find((b) => b.textContent === 'Use recommendation')!
      .click(),
  )
  expect(onPlace).not.toHaveBeenCalled()
  const save = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Save here')!
  expect(save.disabled).toBe(false)
  await act(async () => save.click())
  expect(onPlace).toHaveBeenCalledWith({
    kind: 'xlsx-cells',
    sheet: 'Original',
    cell: 'C7',
    overwrite: false,
  })
})

const BOX = { x: 0.1, y: 0.2, w: 0.3, h: 0.1, fontHeight: 0.05, text: 'Name' }
const boxesPayload = (boxes = [BOX]) => ({
  kind: 'boxes',
  boxes,
  text: boxes.map((b) => b.text).join('\n'),
})
const docxPrepared = (second = false) => ({
  token: 't',
  kind: 'embedded' as const,
  format: 'docx' as const,
  ocr: { kind: 'ai' as const, provider: 'claude' as const },
  items: [
    { index: 1, name: 'a.png', boxable: true },
    ...(second ? [{ index: 2, name: 'b.png' }] : []),
  ],
})
const fakeApi = {
  ocrPreviewLarge: vi.fn(async () => ({ data: new Uint8Array([1, 2, 3]), mime: 'image/jpeg' })),
}

async function mountBoxes(options: {
  prepared?: ReturnType<typeof docxPrepared>
  pages?: unknown[]
}) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  cleanup = () => {
    act(() => root.unmount())
    host.remove()
  }
  const onPlace = vi.fn()
  await act(async () =>
    root.render(
      createElement(
        LocaleProvider,
        { initial: 'en' },
        createElement(OcrPlacementDialog, {
          prepared: options.prepared ?? docxPrepared(true),
          pages: (options.pages ?? [
            { index: 1, payload: boxesPayload() },
            { index: 2, payload: { blocks: [{ runs: [{ text: 'Plain' }] }] } },
          ]) as never,
          busy: false,
          api: fakeApi as never,
          onPlace,
          onCancel: vi.fn(),
        }),
      ),
    ),
  )
  await act(async () => {})
  return { host, onPlace }
}
const optionValues = (host: HTMLElement) =>
  [...host.querySelectorAll('select')[0]!.querySelectorAll('option')].map((o) => o.value)
const saveButton = (host: HTMLElement) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === 'Save here')!

it('offers on-image boxes only for boxable pictures with boxes and selects it by default', async () => {
  const { host } = await mountBoxes({})
  expect(optionValues(host)).toContain('docx-image-boxes')
  expect(host.querySelectorAll('select')[0]!.value).toBe('docx-image-boxes')

  cleanup()
  const plain = await mountBoxes({
    pages: [{ index: 1, payload: { blocks: [{ runs: [{ text: 'Plain' }] }] } }],
    prepared: docxPrepared(),
  })
  expect(optionValues(plain.host)).not.toContain('docx-image-boxes')
  expect(plain.host.querySelectorAll('select')[0]!.value).toBe('')

  cleanup()
  const empty = await mountBoxes({
    pages: [{ index: 1, payload: boxesPayload([]) }],
    prepared: docxPrepared(),
  })
  expect(optionValues(empty.host)).not.toContain('docx-image-boxes')
})

it('the existing destinations are still offered', async () => {
  const { host } = await mountBoxes({})
  expect(optionValues(host)).toEqual(expect.arrayContaining(['docx-after-images', 'docx-end']))
})

it('saving sends a docx-image-boxes placement with the edited boxes', async () => {
  const { host, onPlace } = await mountBoxes({})
  expect(host.querySelectorAll('[data-box]')).toHaveLength(1)
  await act(async () => host.querySelector<HTMLElement>('[data-box]')!.click())
  const text = host.querySelector('textarea') as HTMLTextAreaElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      text,
      'Edited',
    )
    text.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(saveButton(host).disabled).toBe(false)
  await act(async () => saveButton(host).click())
  expect(onPlace).toHaveBeenCalledWith({
    kind: 'docx-image-boxes',
    images: [{ index: 1, boxes: [{ ...BOX, text: 'Edited' }] }],
  })
})

it('pictures without boxes are announced as going after the image', async () => {
  const { host } = await mountBoxes({})
  expect(host.textContent).toContain('b.png')
  expect(host.textContent).toMatch(/paragraph after the image/i)
})

it('a picture whose boxes were all deleted is left out and Save needs at least one box', async () => {
  const { host, onPlace } = await mountBoxes({
    prepared: docxPrepared(),
    pages: [{ index: 1, payload: boxesPayload() }],
  })
  await act(async () => host.querySelector<HTMLElement>('[data-box]')!.click())
  const del = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Delete box')!
  await act(async () => del.click())
  expect(saveButton(host).disabled).toBe(true)
  expect(onPlace).not.toHaveBeenCalled()
})
