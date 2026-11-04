import type { AgentSkill, AgentToolDef, ToolExecution } from '@genoffice/agent-core'
import type { Lang } from '@genoffice/i18n'
import { AI_CHOICE_LABELS } from './strings-ai-choice'

/**
 * The numbered-choice question every editor's AI panel shares.
 *
 * The model asks through the `ask_choice` tool instead of writing a question in prose. The
 * tool shows a card (numbered options plus a typing row), tells the model to stop, and flags
 * the result `awaitingUser` so the status line reads "waiting for you". The person's answer
 * arrives as the next user message in a fixed machine-readable form:
 *
 *   [choice:<id>] 2: <option text>     option number 2 was picked
 *   [choice:<id>] typed: <text>        the person wrote their own answer
 *   [choice:<id>] skipped              the person dismissed the card
 *
 * The chat bubble shows a readable form of the same answer; only the model sees the tag.
 */

export const ASK_CHOICE_TOOL = 'ask_choice'

export const CHOICE_MIN_OPTIONS = 2
export const CHOICE_MAX_OPTIONS = 6

export interface ChoiceRemember {
  /** stable key the host stores the answer under (for example `outputMode`) */
  key: string
  /** optional label for the host's settings screen */
  label?: string
}

export interface ChoiceQuestion {
  id: string
  question: string
  options: string[]
  allowTyping: boolean
  remember?: ChoiceRemember
}

export type ChoiceAnswer =
  | { kind: 'option'; /** 1-based */ index: number; text: string }
  | { kind: 'typed'; text: string }
  | { kind: 'skipped' }

const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/

const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim()

let idCounter = 0
/** A short unique id for a question the model gave none */
export function newChoiceId(): string {
  idCounter += 1
  return `q${Date.now().toString(36)}${idCounter.toString(36)}`
}

export type ParsedChoice = { ok: true; question: ChoiceQuestion } | { ok: false; error: string }

/** Validate the model's tool input; never throws */
export function parseChoiceInput(
  input: Record<string, unknown>,
  makeId: () => string = newChoiceId,
): ParsedChoice {
  const question = typeof input.question === 'string' ? oneLine(input.question) : ''
  if (!question) return { ok: false, error: 'question must be a non-empty string.' }
  const raw = input.options
  if (!Array.isArray(raw) || raw.some((o) => typeof o !== 'string')) {
    return { ok: false, error: 'options must be an array of strings.' }
  }
  const options = (raw as string[]).map(oneLine)
  if (options.length < CHOICE_MIN_OPTIONS || options.length > CHOICE_MAX_OPTIONS) {
    return {
      ok: false,
      error: `options needs ${CHOICE_MIN_OPTIONS} to ${CHOICE_MAX_OPTIONS} entries.`,
    }
  }
  if (options.some((o) => !o)) return { ok: false, error: 'options must not be blank.' }
  const id = typeof input.id === 'string' && ID_PATTERN.test(input.id) ? input.id : makeId()
  const result: ChoiceQuestion = {
    id,
    question,
    options,
    allowTyping: input.allowTyping !== false,
  }
  const rem = input.remember
  if (rem && typeof rem === 'object' && !Array.isArray(rem)) {
    const r = rem as Record<string, unknown>
    if (typeof r.key === 'string' && KEY_PATTERN.test(r.key)) {
      result.remember = {
        key: r.key,
        ...(typeof r.label === 'string' && r.label.trim() ? { label: oneLine(r.label) } : {}),
      }
    }
  }
  return { ok: true, question: result }
}

/** The text the model receives as the person's next message */
export function formatChoiceAnswer(id: string, answer: ChoiceAnswer): string {
  switch (answer.kind) {
    case 'option':
      return `[choice:${id}] ${answer.index}: ${oneLine(answer.text)}`
    case 'typed':
      return `[choice:${id}] typed: ${oneLine(answer.text)}`
    case 'skipped':
      return `[choice:${id}] skipped`
  }
}

/** The text the chat bubble shows for the same answer */
export function choiceAnswerDisplay(answer: ChoiceAnswer, skippedLabel: string): string {
  switch (answer.kind) {
    case 'option':
      return `${answer.index} · ${oneLine(answer.text)}`
    case 'typed':
      return oneLine(answer.text)
    case 'skipped':
      return skippedLabel
  }
}

const ANSWER_PATTERN = /^\[choice:([A-Za-z0-9_-]{1,40})\] (?:(\d{1,2}): (.*)|typed: (.*)|(skipped))$/

/** Read an answer message back (restored histories, tests); null for anything else */
export function parseChoiceAnswerMessage(
  text: string,
): { id: string; answer: ChoiceAnswer } | null {
  const m = ANSWER_PATTERN.exec(text.trim())
  if (!m) return null
  const id = m[1]!
  if (m[2] !== undefined) return { id, answer: { kind: 'option', index: Number(m[2]), text: m[3]! } }
  if (m[4] !== undefined) return { id, answer: { kind: 'typed', text: m[4] } }
  return { id, answer: { kind: 'skipped' } }
}

/**
 * What a chat bubble shows for a user message: the readable form of a tagged answer
 * ("2 · text"), anything else unchanged. Panels apply it when drawing user bubbles, so a
 * restored history reads the same as the live chat.
 */
export function choiceBubbleText(text: string, lang: Lang): string {
  const parsed = parseChoiceAnswerMessage(text)
  return parsed ? choiceAnswerDisplay(parsed.answer, AI_CHOICE_LABELS[lang].skipped) : text
}

// ---- pending card state ----

export interface PendingChoice {
  question: ChoiceQuestion
  /** true once the run that asked has ended: only then can the answer start the next run */
  ready: boolean
}

export type PendingChoiceEvent =
  | { type: 'ask'; question: ChoiceQuestion }
  /** show again at once: the answer could not be sent */
  | { type: 'show'; question: ChoiceQuestion }
  | { type: 'busy'; busy: boolean }
  | { type: 'clear' }

/**
 * The card waits for the asking run to end, then for the person. A different message
 * starting a run while it is shown (typed in the composer, a queued message) retires it.
 */
export function reducePendingChoice(
  state: PendingChoice | null,
  event: PendingChoiceEvent,
): PendingChoice | null {
  switch (event.type) {
    case 'ask':
      return { question: event.question, ready: false }
    case 'show':
      return { question: event.question, ready: true }
    case 'clear':
      return null
    case 'busy':
      if (!state) return state
      if (!event.busy) return state.ready ? state : { ...state, ready: true }
      return state.ready ? null : state
  }
}

// ---- tool and prompt ----

export const CHOICE_PROMPT = `## Asking the person a question (ask_choice)
- When you need a decision from the person, call ask_choice with numbered options instead of asking in prose. Give 2 to 6 short, concrete options in the language the person writes in, put the most likely one first, and keep the question to one sentence. The person can also type their own answer, so do not add an "other" option.
- After calling ask_choice, STOP: write at most one short sentence and end your turn. Do not guess the answer, do not continue the task, and do not call other tools in the same turn.
- Never start writing into the document while a required answer is missing.
- The answer arrives as the person's next message in one of three exact forms: "[choice:<id>] <number>: <option text>" (that option was picked), "[choice:<id>] typed: <text>" (the person wrote their own answer), "[choice:<id>] skipped" (the person dismissed the question). Treat it as the answer to that question, not as a new request.
- On "skipped", continue with the safest default that changes nothing irreversible, or ask once in prose if no safe default exists. Never ask the same question again after an answer.
- Pass a remember {key} only when the host's instructions name that key; the person can then keep the answer for the rest of the project.`

const TOOL: AgentToolDef = {
  name: ASK_CHOICE_TOOL,
  description:
    'Ask the person a question as a card with numbered options (2-6) and a typing row; use it instead of asking in prose. After calling it, stop and wait. The answer comes back as the next user message: "[choice:<id>] <number>: <option text>" for a picked option, "[choice:<id>] typed: <text>" for their own text, "[choice:<id>] skipped" when dismissed.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Short identifier of the question (letters, digits, - or _). Optional.',
      },
      question: { type: 'string', description: 'The question, one sentence.' },
      options: {
        type: 'array',
        minItems: CHOICE_MIN_OPTIONS,
        maxItems: CHOICE_MAX_OPTIONS,
        items: { type: 'string' },
        description: 'Numbered options, shown as 1..N in this order.',
      },
      allowTyping: {
        type: 'boolean',
        description: 'Offer a row for the person to type their own answer. Default true.',
      },
      remember: {
        type: 'object',
        properties: { key: { type: 'string' }, label: { type: 'string' } },
        required: ['key'],
        description:
          'Offer "use this for the rest of the project" for this question. Only with a key the instructions name.',
      },
    },
    required: ['question', 'options'],
  },
}

export interface ChoiceSkillOptions {
  /** show the card; called once per valid ask_choice call */
  ask(question: ChoiceQuestion): void
}

/** The shared tool as an agent skill; every panel registers it through `useAiChoice` */
export function createChoiceSkill(options: ChoiceSkillOptions): AgentSkill {
  return {
    id: 'ask-choice',
    systemPrompt: CHOICE_PROMPT,
    tools: [TOOL],
    executeTool: (call): ToolExecution => {
      if (call.name !== ASK_CHOICE_TOOL) {
        return { output: `Unknown tool: ${call.name}`, isError: true, summary: ASK_CHOICE_TOOL }
      }
      const parsed = parseChoiceInput(call.input)
      if (!parsed.ok) {
        return { output: parsed.error, isError: true, summary: ASK_CHOICE_TOOL }
      }
      options.ask(parsed.question)
      const q = parsed.question
      return {
        output:
          `The question is shown to the person as a card with ${q.options.length} numbered options` +
          `${q.allowTyping ? ' and a row to type their own answer' : ''}. STOP now: write at most one short sentence and end your turn. ` +
          `Do not continue the task or call other tools until the answer arrives as the next message, ` +
          `in the form "[choice:${q.id}] <number>: <option text>", "[choice:${q.id}] typed: <text>" or "[choice:${q.id}] skipped".`,
        mutated: false,
        summary: q.question.length > 60 ? `${q.question.slice(0, 59)}…` : q.question,
        awaitingUser: true,
      }
    },
  }
}
