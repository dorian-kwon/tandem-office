import React, { useEffect, useId, useRef, useState } from 'react'
import type { Lang } from '@genoffice/i18n'
import type { ChoiceAnswer, ChoiceQuestion } from './ai-choice'
import { AI_CHOICE_LABELS } from './strings-ai-choice'
import './ai-choice.css'

export interface AiChoiceCardProps {
  readonly question: ChoiceQuestion
  readonly lang: Lang
  /** show the "use this for the rest of the project" checkbox (the host stores it) */
  readonly canRemember: boolean
  /** `remember` is true only when the checkbox was ticked and the answer is an option or typed text */
  onAnswer(answer: ChoiceAnswer, remember: boolean): void
}

/** An element the digit shortcut may fire from: nothing is being typed into it */
function digitShortcutAllowed(target: EventTarget | null, card: HTMLElement | null): boolean {
  if (!(target instanceof HTMLElement)) return true
  if (card?.contains(target)) {
    // typing into the card's own row must keep its digits
    return !(target instanceof HTMLInputElement && target.type === 'text')
  }
  if (target === document.body) return true
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    return target.value === ''
  }
  // a document editor (contenteditable) or anything else owns its keys
  return false
}

/**
 * The AI's numbered question: options 1..N as buttons, a last row to type an answer.
 * Keys: 1-9 pick an option (focus in the card, or an empty composer), Enter sends typed
 * text, Esc skips. Colors come from tokens; motion stops under reduced motion.
 */
export function AiChoiceCard({
  question,
  lang,
  canRemember,
  onAnswer,
}: AiChoiceCardProps): React.JSX.Element {
  const labels = AI_CHOICE_LABELS[lang]
  const titleId = useId()
  const cardRef = useRef<HTMLDivElement>(null)
  const [typed, setTyped] = useState('')
  const [remember, setRemember] = useState(false)
  const answeredRef = useRef(false)

  const answer = (a: ChoiceAnswer): void => {
    if (answeredRef.current) return
    answeredRef.current = true
    onAnswer(a, remember && canRemember && question.remember !== undefined && a.kind !== 'skipped')
  }
  const answerRef = useRef(answer)
  answerRef.current = answer

  // a new question starts clean and takes focus so the keys work at once
  useEffect(() => {
    answeredRef.current = false
    setTyped('')
    setRemember(false)
    cardRef.current?.focus({ preventScroll: true })
  }, [question.id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.isComposing) return
      if (!/^[1-9]$/.test(e.key)) return
      const index = Number(e.key)
      const text = question.options[index - 1]
      if (text === undefined) return
      if (!digitShortcutAllowed(e.target, cardRef.current)) return
      e.preventDefault()
      answerRef.current({ kind: 'option', index, text })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [question])

  const sendTyped = (): void => {
    const text = typed.trim()
    if (text) answer({ kind: 'typed', text })
  }

  return (
    <div
      ref={cardRef}
      className="ai-choice-card"
      role="group"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          answer({ kind: 'skipped' })
        }
      }}
    >
      <p id={titleId} className="ai-choice-question">
        {question.question}
      </p>
      <div className="ai-choice-options">
        {question.options.map((text, i) => (
          <button
            key={i}
            type="button"
            className="ai-choice-option"
            aria-keyshortcuts={String(i + 1)}
            onClick={() => answer({ kind: 'option', index: i + 1, text })}
          >
            <span className="ai-choice-num" aria-hidden>
              {i + 1}
            </span>
            <span className="ai-choice-text">{text}</span>
          </button>
        ))}
      </div>
      {question.allowTyping && (
        <div className="ai-choice-own">
          <input
            type="text"
            className="ai-choice-input"
            value={typed}
            placeholder={labels.ownPlaceholder}
            aria-label={labels.ownLabel}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              // an IME composition's Enter commits the text, it does not send
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                sendTyped()
              }
            }}
          />
          <button
            type="button"
            className="ai-choice-send"
            disabled={typed.trim() === ''}
            onClick={sendTyped}
          >
            {labels.send}
          </button>
        </div>
      )}
      {canRemember && question.remember && (
        <label className="ai-choice-remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          <span>{labels.remember}</span>
        </label>
      )}
      <div className="ai-choice-foot">
        <span className="ai-choice-hint">{labels.hint}</span>
        <button
          type="button"
          className="ai-choice-skip"
          aria-keyshortcuts="Escape"
          onClick={() => answer({ kind: 'skipped' })}
        >
          {labels.skip}
        </button>
      </div>
    </div>
  )
}
