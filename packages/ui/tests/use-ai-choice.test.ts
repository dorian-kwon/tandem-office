/** @vitest-environment jsdom */
import { act, createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAiChoice, type AiChoiceController, type UseAiChoiceOptions } from '../src/use-ai-choice'

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

let controller: AiChoiceController
function Panel(props: UseAiChoiceOptions): ReactNode {
  controller = useAiChoice(props)
  return controller.card
}

const mount = (props: Partial<UseAiChoiceOptions> = {}) => {
  const send = vi.fn<(t: string, d: string) => boolean | void>()
  const base: UseAiChoiceOptions = { lang: 'en', busy: true, send, ...props }
  const render = (p: Partial<UseAiChoiceOptions>) =>
    act(() => root.render(createElement(Panel, { ...base, ...p })))
  render({})
  return { send: (props.send as typeof send) ?? send, render }
}

const ask = (input: Record<string, unknown>) =>
  act(() => {
    void controller.skill.executeTool({ id: 't', name: 'ask_choice', input })
  })

it('shows the card only after the asking run ends, then sends the tagged answer with a readable bubble', () => {
  const { send, render } = mount()
  ask({ id: 'mode', question: 'Overwrite?', options: ['Overwrite', 'Keep both'] })
  expect(host.querySelector('.ai-choice-card')).toBeNull()
  render({ busy: false })
  expect(host.querySelector('.ai-choice-card')).not.toBeNull()
  act(() => (host.querySelectorAll('button.ai-choice-option')[1] as HTMLElement).click())
  expect(send).toHaveBeenCalledWith('[choice:mode] 2: Keep both', '2 · Keep both')
  expect(host.querySelector('.ai-choice-card')).toBeNull()
})

it('sends a localized bubble for a skip', () => {
  const { send, render } = mount({ lang: 'ko' })
  ask({ id: 'a', question: 'q', options: ['x', 'y'] })
  render({ busy: false })
  act(() => (host.querySelector('button.ai-choice-skip') as HTMLElement).click())
  expect(send).toHaveBeenCalledWith('[choice:a] skipped', '질문을 건너뛰었습니다')
})

it('retires the card when the person starts a different run instead', () => {
  const { render } = mount()
  ask({ id: 'a', question: 'q', options: ['x', 'y'] })
  render({ busy: false })
  expect(host.querySelector('.ai-choice-card')).not.toBeNull()
  render({ busy: true })
  expect(host.querySelector('.ai-choice-card')).toBeNull()
})

it('keeps the question when the panel refuses the answer', () => {
  const send = vi.fn(() => false)
  const { render } = mount({ send })
  ask({ id: 'a', question: 'q', options: ['x', 'y'] })
  render({ busy: false })
  act(() => (host.querySelectorAll('button.ai-choice-option')[0] as HTMLElement).click())
  expect(host.querySelector('.ai-choice-card')).not.toBeNull()
})

it('stores a remembered answer through the host only when it can, and never on a skip', () => {
  const store = vi.fn()
  const remember = { can: (key: string) => key === 'outputMode', store }
  const { render } = mount({ remember })
  ask({ id: 'a', question: 'q', options: ['x', 'y'], remember: { key: 'outputMode' } })
  render({ busy: false })
  act(() => (host.querySelector('.ai-choice-remember input') as HTMLElement).click())
  act(() => (host.querySelectorAll('button.ai-choice-option')[0] as HTMLElement).click())
  expect(store).toHaveBeenCalledWith(
    'outputMode',
    { kind: 'option', index: 1, text: 'x' },
    expect.objectContaining({ id: 'a' }),
  )

  render({ busy: true })
  ask({ id: 'b', question: 'q', options: ['x', 'y'], remember: { key: 'other' } })
  render({ busy: false })
  expect(host.querySelector('.ai-choice-remember')).toBeNull()
})
