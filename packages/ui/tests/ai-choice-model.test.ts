import { describe, expect, it, vi } from 'vitest'
import type { AgentToolCall } from '@genoffice/agent-core'
import {
  ASK_CHOICE_TOOL,
  choiceAnswerDisplay,
  createChoiceSkill,
  formatChoiceAnswer,
  parseChoiceAnswerMessage,
  parseChoiceInput,
  reducePendingChoice,
  type ChoiceQuestion,
} from '../src/ai-choice'

const call = (input: Record<string, unknown>): AgentToolCall => ({
  id: 't1',
  name: ASK_CHOICE_TOOL,
  input,
})

describe('parseChoiceInput', () => {
  it('accepts a minimal question and fills the defaults', () => {
    const r = parseChoiceInput({ question: ' Where? ', options: ['A', 'B'] }, () => 'gen1')
    expect(r).toEqual({
      ok: true,
      question: { id: 'gen1', question: 'Where?', options: ['A', 'B'], allowTyping: true },
    })
  })

  it('keeps a clean model id and replaces an unsafe one', () => {
    const clean = parseChoiceInput({ id: 'out-mode_1', question: 'q', options: ['a', 'b'] }, () => 'g')
    expect(clean.ok && clean.question.id).toBe('out-mode_1')
    const unsafe = parseChoiceInput({ id: 'a] b', question: 'q', options: ['a', 'b'] }, () => 'g')
    expect(unsafe.ok && unsafe.question.id).toBe('g')
  })

  it('rejects fewer than 2 or more than 6 options and blank options', () => {
    expect(parseChoiceInput({ question: 'q', options: ['only'] }).ok).toBe(false)
    expect(parseChoiceInput({ question: 'q', options: ['1', '2', '3', '4', '5', '6', '7'] }).ok).toBe(
      false,
    )
    expect(parseChoiceInput({ question: 'q', options: ['a', '  '] }).ok).toBe(false)
    expect(parseChoiceInput({ question: '  ', options: ['a', 'b'] }).ok).toBe(false)
    expect(parseChoiceInput({ question: 'q', options: 'a,b' }).ok).toBe(false)
  })

  it('collapses whitespace inside options so the answer stays one line', () => {
    const r = parseChoiceInput({ question: 'q', options: ['a\n b', 'c'] })
    expect(r.ok && r.question.options[0]).toBe('a b')
  })

  it('reads allowTyping and remember', () => {
    const r = parseChoiceInput({
      question: 'q',
      options: ['a', 'b'],
      allowTyping: false,
      remember: { key: 'outputMode', label: 'x' },
    })
    expect(r.ok && r.question.allowTyping).toBe(false)
    expect(r.ok && r.question.remember).toEqual({ key: 'outputMode', label: 'x' })
    const bad = parseChoiceInput({ question: 'q', options: ['a', 'b'], remember: { key: '' } })
    expect(bad.ok && bad.question.remember).toBeUndefined()
  })
})

describe('answer messages', () => {
  const q: ChoiceQuestion = { id: 'q1', question: 'q', options: ['Overwrite', 'Keep both'], allowTyping: true }

  it('formats the machine form for each kind of answer', () => {
    expect(formatChoiceAnswer('q1', { kind: 'option', index: 2, text: 'Keep both' })).toBe(
      '[choice:q1] 2: Keep both',
    )
    expect(formatChoiceAnswer('q1', { kind: 'typed', text: 'next to it' })).toBe(
      '[choice:q1] typed: next to it',
    )
    expect(formatChoiceAnswer('q1', { kind: 'skipped' })).toBe('[choice:q1] skipped')
  })

  it('round-trips through the parser', () => {
    const answers = [
      { kind: 'option', index: 2, text: 'Keep both' },
      { kind: 'typed', text: 'with: colon and 3: digits' },
      { kind: 'skipped' },
    ] as const
    for (const a of answers) {
      expect(parseChoiceAnswerMessage(formatChoiceAnswer(q.id, a))).toEqual({ id: 'q1', answer: a })
    }
    expect(parseChoiceAnswerMessage('hello')).toBeNull()
    expect(parseChoiceAnswerMessage('[choice:q1] nonsense')).toBeNull()
  })

  it('flattens newlines of typed text', () => {
    expect(formatChoiceAnswer('q1', { kind: 'typed', text: 'a\nb' })).toBe('[choice:q1] typed: a b')
  })

  it('shows a readable bubble', () => {
    expect(choiceAnswerDisplay({ kind: 'option', index: 2, text: 'Keep both' }, 'Skipped')).toBe(
      '2 · Keep both',
    )
    expect(choiceAnswerDisplay({ kind: 'typed', text: 'next to it' }, 'Skipped')).toBe('next to it')
    expect(choiceAnswerDisplay({ kind: 'skipped' }, 'Skipped')).toBe('Skipped')
  })
})

describe('createChoiceSkill', () => {
  it('declares one tool whose description documents the answer format', () => {
    const skill = createChoiceSkill({ ask: () => {} })
    expect(skill.tools).toHaveLength(1)
    const tool = skill.tools?.[0]
    expect(tool?.name).toBe('ask_choice')
    expect(tool?.description).toContain('[choice:')
    expect(skill.systemPrompt).toContain('ask_choice')
    expect(skill.systemPrompt).toContain('[choice:<id>] typed:')
    expect(skill.systemPrompt).toContain('skipped')
  })

  it('shows the question, stops the run in the waiting state and returns a wait instruction', async () => {
    const ask = vi.fn()
    const skill = createChoiceSkill({ ask })
    const result = await skill.executeTool(
      call({ id: 'ocr1', question: 'Where do the words go?', options: ['Column B', 'New sheet'] }),
    )
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0]?.[0]).toMatchObject({ id: 'ocr1', options: ['Column B', 'New sheet'] })
    expect(result.awaitingUser).toBe(true)
    expect(result.isError).toBeFalsy()
    expect(result.mutated).toBe(false)
    expect(result.output).toMatch(/STOP/)
    expect(result.output).toContain('[choice:ocr1]')
  })

  it('refuses a bad question without showing a card', async () => {
    const ask = vi.fn()
    const skill = createChoiceSkill({ ask })
    const result = await skill.executeTool(call({ question: 'q', options: ['one'] }))
    expect(ask).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
    expect(result.awaitingUser).toBeFalsy()
  })

  it('refuses an unknown tool name', async () => {
    const skill = createChoiceSkill({ ask: () => {} })
    const result = await skill.executeTool({ id: 'x', name: 'other', input: {} })
    expect(result.isError).toBe(true)
  })
})

describe('reducePendingChoice', () => {
  const q: ChoiceQuestion = { id: 'q1', question: 'q', options: ['a', 'b'], allowTyping: true }

  it('shows the card once the asking run has ended', () => {
    let s = reducePendingChoice(null, { type: 'ask', question: q })
    expect(s?.ready).toBe(false)
    s = reducePendingChoice(s, { type: 'busy', busy: false })
    expect(s?.ready).toBe(true)
  })

  it('drops the card when another message starts a run after it was shown', () => {
    let s = reducePendingChoice(null, { type: 'ask', question: q })
    s = reducePendingChoice(s, { type: 'busy', busy: true })
    expect(s).not.toBeNull()
    s = reducePendingChoice(s, { type: 'busy', busy: false })
    s = reducePendingChoice(s, { type: 'busy', busy: true })
    expect(s).toBeNull()
  })

  it('a newer question replaces the older one; answering clears', () => {
    let s = reducePendingChoice(null, { type: 'ask', question: q })
    s = reducePendingChoice(s, { type: 'ask', question: { ...q, id: 'q2' } })
    expect(s?.question.id).toBe('q2')
    expect(reducePendingChoice(s, { type: 'clear' })).toBeNull()
  })
})
