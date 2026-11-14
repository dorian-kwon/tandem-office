/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { LocaleProvider } from '../src/renderer/src/locale'
import { OcrBoxEditor } from '../src/renderer/src/translate/OcrBoxEditor'
import type { OcrBox } from '../src/shared/ocr-boxes'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let cleanup = () => {}
afterEach(() => cleanup())

const boxes: OcrBox[] = [
  { x: 0.1, y: 0.2, w: 0.3, h: 0.1, fontHeight: 0.05, text: 'Name' },
  { x: 0.5, y: 0.6, w: 0.2, h: 0.1, fontHeight: 0.05, text: 'Date' },
]

async function mount(props: Partial<Parameters<typeof OcrBoxEditor>[0]> = {}) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  cleanup = () => {
    act(() => root.unmount())
    host.remove()
  }
  const onChange = vi.fn()
  const onSelect = vi.fn()
  await act(async () =>
    root.render(
      createElement(
        LocaleProvider,
        { initial: 'en' },
        createElement(OcrBoxEditor, {
          src: 'data:image/png;base64,AAAA',
          boxes,
          selected: 0,
          disabled: false,
          onChange,
          onSelect,
          ...props,
        }),
      ),
    ),
  )
  return { host, onChange, onSelect }
}
const key = (el: Element, k: string, init: KeyboardEventInit = {}) =>
  act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }))
  })

it('renders one labelled box per OcrBox at percent positions', async () => {
  const { host } = await mount()
  const drawn = [...host.querySelectorAll<HTMLElement>('[data-box]')]
  expect(drawn).toHaveLength(2)
  expect(drawn[0]!.style.left).toBe('10%')
  expect(drawn[0]!.style.top).toBe('20%')
  expect(drawn[0]!.style.width).toBe('30%')
  expect(drawn[0]!.style.height).toBe('10%')
  expect(drawn[0]!.getAttribute('aria-label')).toBe('Box 1: Name')
  expect(drawn[1]!.getAttribute('aria-label')).toBe('Box 2: Date')
  expect(host.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,AAAA')
})

it('Delete removes the selected box and arrow keys move it', async () => {
  const { host, onChange, onSelect } = await mount()
  const first = host.querySelector<HTMLElement>('[data-box]')!
  await key(first, 'ArrowRight')
  expect(onChange).toHaveBeenLastCalledWith([{ ...boxes[0], x: 0.11 }, boxes[1]])
  await key(first, 'ArrowDown', { shiftKey: true })
  expect(onChange).toHaveBeenLastCalledWith([{ ...boxes[0], h: 0.11 }, boxes[1]])
  await key(first, 'Delete')
  expect(onChange).toHaveBeenLastCalledWith([boxes[1]])
  expect(onSelect).toHaveBeenLastCalledWith(null)
})

it('edits the text of the selected box and adds and deletes boxes with buttons', async () => {
  const { host, onChange } = await mount()
  const text = host.querySelector('textarea') as HTMLTextAreaElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      text,
      'Edited',
    )
    text.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(onChange).toHaveBeenLastCalledWith([{ ...boxes[0], text: 'Edited' }, boxes[1]])
  const add = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Add box')!
  await act(async () => add.click())
  expect(onChange.mock.calls.at(-1)![0]).toHaveLength(3)
  const del = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Delete box')!
  await act(async () => del.click())
  expect(onChange).toHaveBeenLastCalledWith([boxes[1]])
})

it('does nothing while disabled', async () => {
  const { host, onChange } = await mount({ disabled: true })
  await key(host.querySelector('[data-box]')!, 'Delete')
  expect(onChange).not.toHaveBeenCalled()
  expect(host.querySelector('textarea')!.disabled).toBe(true)
})
