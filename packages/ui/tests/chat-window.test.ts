/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EarlierChatMessages, recentChatStart, useChatWindow } from '../src/chat-window'

const messages = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    text: `message ${i}`,
  }))
it('keeps roughly thirty entries at a user turn boundary without changing history', () => {
  const entries = messages(63)
  expect(recentChatStart(entries)).toBe(32)
  expect(entries).toEqual(messages(63))
  expect(recentChatStart(messages(5))).toBe(0)
})
it('never hides a streaming entry or splits its user/assistant turn', () => {
  const entries = messages(80).map((entry, i) => ({ ...entry, streaming: i === 11 }))
  expect(recentChatStart(entries)).toBe(10)
  expect(recentChatStart([{ role: 'user' }, ...Array(80).fill({ role: 'assistant' })])).toBe(0)
})
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})
function Panel({
  chat,
  busy = false,
  history = [],
}: {
  chat: ReturnType<typeof messages>
  busy?: boolean
  history?: ReturnType<typeof messages>
}) {
  const window = useChatWindow(chat, busy, history)
  return createElement(
    'div',
    null,
    createElement(EarlierChatMessages, { ...window, lang: 'en' }),
    ...window.history.map(({ entry, index }) =>
      createElement('p', { key: `h${index}` }, `h${index} ${entry.text}`),
    ),
    ...window.chat.map(({ entry, index }) =>
      createElement('p', { key: index }, `${index} ${entry.text}`),
    ),
  )
}
it('expands combined stored/current history, preserving absolute indices, then resets on send', () => {
  const history = messages(40),
    chat = messages(10)
  act(() => root.render(createElement(Panel, { chat, history })))
  expect(host.querySelector('button')?.textContent).toBe('Show 20 earlier messages')
  expect(host.querySelectorAll('p')).toHaveLength(30)
  expect(host.querySelector('p')?.textContent).toBe('h20 message 20')
  act(() => host.querySelector('button')!.click())
  expect(host.querySelectorAll('p')).toHaveLength(50)
  act(() => root.render(createElement(Panel, { chat, history, busy: true })))
  expect(host.querySelectorAll('p')).toHaveLength(30)
  expect(chat).toHaveLength(10)
  expect(history).toHaveLength(40)
})
it('stays expanded through streamed updates but collapses for a queued next user', () => {
  const chat = messages(60)
  act(() => root.render(createElement(Panel, { chat, busy: true })))
  act(() => host.querySelector('button')!.click())
  const updated = [
    { ...chat[0]!, text: 'patched first message' },
    ...chat.slice(1, -1),
    { role: 'assistant', text: 'new reply' },
  ]
  act(() => root.render(createElement(Panel, { chat: updated, busy: true })))
  expect(host.querySelector('button')).toBeNull()
  act(() =>
    root.render(
      createElement(Panel, { chat: [...updated, { role: 'user', text: 'next' }], busy: true }),
    ),
  )
  expect(host.querySelector('button')).not.toBeNull()
})

it('preserves the visible message position when older messages are expanded above it', () => {
  act(() => root.render(createElement(Panel, { chat: messages(60) })))
  const scroller = host.firstElementChild as HTMLElement
  Object.defineProperty(scroller, 'scrollHeight', {
    get: () => scroller.querySelectorAll('p').length * 10,
  })
  scroller.scrollTop = 100
  act(() => host.querySelector('button')!.click())
  expect(scroller.scrollTop).toBe(400)
})
