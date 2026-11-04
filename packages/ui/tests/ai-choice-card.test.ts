/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LANGS } from '@genoffice/i18n'
import { AiChoiceCard } from '../src/AiChoiceCard'
import type { ChoiceQuestion } from '../src/ai-choice'
import { AI_CHOICE_LABELS } from '../src/strings-ai-choice'

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

const question: ChoiceQuestion = {
  id: 'q1',
  question: 'Where should the text go?',
  options: ['Column B', 'New sheet', 'Keep as reference'],
  allowTyping: true,
}

function render(
  props: Partial<{ question: ChoiceQuestion; canRemember: boolean }> = {},
  onAnswer = vi.fn(),
) {
  act(() =>
    root.render(
      createElement(AiChoiceCard, {
        question: props.question ?? question,
        lang: 'en',
        canRemember: props.canRemember ?? false,
        onAnswer,
      }),
    ),
  )
  return onAnswer
}

const key = (target: EventTarget, k: string, init: KeyboardEventInit = {}) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }))
  })

it('renders a labelled group with numbered option buttons and a typing row', () => {
  render()
  const group = host.querySelector('[role="group"]')!
  const labelId = group.getAttribute('aria-labelledby')!
  expect(document.getElementById(labelId)?.textContent).toBe(question.question)
  const buttons = [...host.querySelectorAll('button.ai-choice-option')]
  expect(buttons).toHaveLength(3)
  expect(buttons[1]?.getAttribute('aria-keyshortcuts')).toBe('2')
  expect(buttons[1]?.textContent).toContain('2')
  expect(buttons[1]?.textContent).toContain('New sheet')
  const input = host.querySelector('input.ai-choice-input') as HTMLInputElement
  expect(input.placeholder).toBe(AI_CHOICE_LABELS.en.ownPlaceholder)
})

it('hides the typing row when typing is not allowed', () => {
  render({ question: { ...question, allowTyping: false } })
  expect(host.querySelector('input.ai-choice-input')).toBeNull()
})

it('answers with the clicked option', () => {
  const onAnswer = render()
  act(() => (host.querySelectorAll('button.ai-choice-option')[1] as HTMLElement).click())
  expect(onAnswer).toHaveBeenCalledWith({ kind: 'option', index: 2, text: 'New sheet' }, false)
})

it('picks with a number key from the card, from the page and from an empty composer', () => {
  const composer = document.createElement('textarea')
  document.body.append(composer)
  const onAnswer = render()
  key(host.querySelector('.ai-choice-card')!, '3')
  expect(onAnswer).toHaveBeenLastCalledWith(
    { kind: 'option', index: 3, text: 'Keep as reference' },
    false,
  )
  // a fresh card, answered from the empty composer
  const second = render({ question: { ...question, id: 'q2' } })
  key(composer, '1')
  expect(second).toHaveBeenCalledWith({ kind: 'option', index: 1, text: 'Column B' }, false)
  composer.remove()
})

it('does not steal digits from a composer with text, an editor or the typing row', () => {
  const composer = document.createElement('textarea')
  composer.value = 'abc'
  const editable = document.createElement('div')
  editable.contentEditable = 'true'
  document.body.append(composer, editable)
  const onAnswer = render()
  key(composer, '1')
  key(editable, '1')
  key(host.querySelector('input.ai-choice-input')!, '1')
  key(document.body, '9') // beyond the option count
  key(document.body, '1', { ctrlKey: true })
  expect(onAnswer).not.toHaveBeenCalled()
  composer.remove()
  editable.remove()
})

it('sends typed text on Enter, trims it, and ignores empty text and IME composition', () => {
  const onAnswer = render()
  const input = host.querySelector('input.ai-choice-input') as HTMLInputElement
  const setValue = (v: string) =>
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, v)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  key(input, 'Enter')
  expect(onAnswer).not.toHaveBeenCalled()
  setValue('  beside the picture  ')
  key(input, 'Enter', { isComposing: true })
  expect(onAnswer).not.toHaveBeenCalled()
  key(input, 'Enter')
  expect(onAnswer).toHaveBeenCalledWith({ kind: 'typed', text: 'beside the picture' }, false)
})

it('skips on Escape and on the Skip button, once', () => {
  const onAnswer = render()
  key(host.querySelector('.ai-choice-card')!, 'Escape')
  act(() => (host.querySelector('button.ai-choice-skip') as HTMLElement).click())
  expect(onAnswer).toHaveBeenCalledTimes(1)
  expect(onAnswer).toHaveBeenCalledWith({ kind: 'skipped' }, false)
})

it('shows the remember checkbox only when the host allows it and the question offers it', () => {
  const remembering = { ...question, remember: { key: 'outputMode' } }
  render({ question: remembering, canRemember: false })
  expect(host.querySelector('.ai-choice-remember')).toBeNull()
  render({ question, canRemember: true })
  expect(host.querySelector('.ai-choice-remember')).toBeNull()
  const onAnswer = render({ question: remembering, canRemember: true })
  const box = host.querySelector('.ai-choice-remember input') as HTMLInputElement
  expect(box).not.toBeNull()
  act(() => box.click())
  act(() => (host.querySelectorAll('button.ai-choice-option')[0] as HTMLElement).click())
  expect(onAnswer).toHaveBeenCalledWith({ kind: 'option', index: 1, text: 'Column B' }, true)
})

it('never remembers a skip', () => {
  const onAnswer = render({ question: { ...question, remember: { key: 'k' } }, canRemember: true })
  act(() => (host.querySelector('.ai-choice-remember input') as HTMLElement).click())
  key(host.querySelector('.ai-choice-card')!, 'Escape')
  expect(onAnswer).toHaveBeenCalledWith({ kind: 'skipped' }, false)
})

it('has every label in all 21 languages, none left blank', () => {
  expect(LANGS).toHaveLength(21)
  const keys = Object.keys(AI_CHOICE_LABELS.en).sort()
  for (const lang of LANGS) {
    expect(Object.keys(AI_CHOICE_LABELS[lang]).sort(), lang).toEqual(keys)
    for (const value of Object.values(AI_CHOICE_LABELS[lang])) {
      expect(value.trim().length, lang).toBeGreaterThan(0)
    }
    if (lang !== 'en') expect(AI_CHOICE_LABELS[lang].ownLabel, lang).not.toBe(AI_CHOICE_LABELS.en.ownLabel)
  }
})
