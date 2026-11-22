import React, { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import type { AgentSkill } from '@genoffice/agent-core'
import type { BatchTranslationChoices } from '@genoffice/project-store/editor-run'
import type { Lang } from '@genoffice/i18n'
import { AiChoiceCard } from './AiChoiceCard'
import {
  choiceAnswerDisplay,
  createChoiceSkill,
  formatChoiceAnswer,
  reducePendingChoice,
  type ChoiceAnswer,
  type ChoiceQuestion,
  type PendingChoice,
} from './ai-choice'
import { AI_CHOICE_LABELS } from './strings-ai-choice'

/** How a host keeps an answer "for the rest of the project"; absent means it cannot */
export interface ChoiceRememberHost {
  /** whether this key can be stored here now (the checkbox shows only then) */
  can(key: string): boolean
  /** store the picked option or typed text; never called for a skip */
  store(
    key: string,
    answer: Exclude<ChoiceAnswer, { kind: 'skipped' }>,
    question: ChoiceQuestion,
  ): void
}

export interface UseAiChoiceOptions {
  batchChoices?: () => BatchTranslationChoices | undefined
  lang: Lang
  /** the panel's busy flag: the card waits for the asking run to end */
  busy: boolean
  /**
   * Start the next run with the answer. `text` goes to the model (the tagged form), `display`
   * is what the chat bubble shows. The panel's own send path owns gating and persistence.
   */
  send(text: string, display: string): boolean | void
  remember?: ChoiceRememberHost | undefined
}

export interface AiChoiceController {
  /** register in the panel's skill list; stable for the panel's lifetime */
  readonly skill: AgentSkill
  /** render above the status line and composer; null when nothing is asked */
  readonly card: React.ReactNode
  readonly pending: PendingChoice | null
  /** drop the card without answering (new chat, document switched) */
  dismiss(): void
}

/** The shared `ask_choice` tool and its card for one AI panel */
export function useAiChoice(options: UseAiChoiceOptions): AiChoiceController {
  const [pending, dispatch] = useReducer(reducePendingChoice, null)
  const optionsRef = useRef(options)
  optionsRef.current = options

  useEffect(() => {
    dispatch({ type: 'busy', busy: options.busy })
  }, [options.busy])

  // the loop outlives one render: the skill reaches the latest state through stable callbacks
  const skill = useMemo(
    () =>
      createChoiceSkill({
        ask: (question) => dispatch({ type: 'ask', question }),
        batchChoices: () => optionsRef.current.batchChoices?.(),
      }),
    [],
  )
  const dismiss = useCallback(() => dispatch({ type: 'clear' }), [])

  const onAnswer = (question: ChoiceQuestion, answer: ChoiceAnswer, remember: boolean): void => {
    const o = optionsRef.current
    dispatch({ type: 'clear' })
    const sent = o.send(
      formatChoiceAnswer(question.id, answer),
      choiceAnswerDisplay(answer, AI_CHOICE_LABELS[o.lang].skipped),
    )
    // the panel refused (busy, held by a gate): keep the question so the person can answer again
    if (sent === false) {
      dispatch({ type: 'show', question })
      return
    }
    if (remember && question.remember && answer.kind !== 'skipped') {
      o.remember?.store(question.remember.key, answer, question)
    }
  }

  const card =
    pending?.ready === true ? (
      <AiChoiceCard
        key={pending.question.id}
        question={pending.question}
        lang={options.lang}
        canRemember={
          pending.question.remember !== undefined &&
          options.remember?.can(pending.question.remember.key) === true
        }
        onAnswer={(answer, remember) => onAnswer(pending.question, answer, remember)}
      />
    ) : null

  return useMemo(() => ({ skill, card, pending, dismiss }), [skill, card, pending, dismiss])
}
