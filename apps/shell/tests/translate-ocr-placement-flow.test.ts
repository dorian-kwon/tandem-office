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
