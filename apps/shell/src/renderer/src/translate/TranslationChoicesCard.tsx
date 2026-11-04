import { useState } from 'react'
import type { TranslationChoiceKey, TranslationChoices } from '@genoffice/translate-project'
import type { TranslateStringKey } from '../i18n/strings-translate'

/** The renderer cannot import the package's list at runtime: same keys, same order. */
const CHOICE_ROWS: ReadonlyArray<{ key: TranslationChoiceKey; label: TranslateStringKey }> = [
  { key: 'outputMode', label: 'choiceOutputMode' },
  { key: 'bilingual', label: 'choiceBilingual' },
  { key: 'ocrPlacement', label: 'choiceOcrPlacement' },
]

/**
 * The answers kept for this project from the AI's question card (output mode, bilingual
 * layout, OCR placement). Each shows its stored answer, or that the AI will ask; "Reset"
 * forgets one so the AI asks again.
 */
export function TranslationChoicesCard({
  choices,
  onSave,
  s,
}: {
  choices: TranslationChoices | undefined
  /** replaces the stored set; resolves true when saved */
  onSave: (next: TranslationChoices) => Promise<boolean>
  s: (key: TranslateStringKey, params?: Record<string, string | number>) => string
}) {
  const [failed, setFailed] = useState(false)
  const reset = async (key: TranslationChoiceKey) => {
    const next: TranslationChoices = { ...choices }
    delete next[key]
    setFailed(!(await onSave(next)))
  }
  return (
    <section className="translate-card-section tt-choices-card" data-choices-card>
      <div className="translate-field-head">
        <h3 className="translate-section-title">{s('choicesTitle')}</h3>
        {failed && (
          <span className="translate-saved is-failed" role="status">
            {s('promptNotSaved')}
          </span>
        )}
      </div>
      <p className="projects-hint">{s('choicesHint')}</p>
      <ul className="tt-choices">
        {CHOICE_ROWS.map(({ key, label }) => {
          const value = choices?.[key]
          return (
            <li key={key} className="tt-choice" data-choice={key}>
              <span className="tt-choice-name">{s(label)}</span>
              <span className={`tt-choice-value${value ? '' : ' is-undecided'}`}>
                {value ?? s('choiceUndecided')}
              </span>
              {value && (
                <button
                  type="button"
                  className="btn btn-secondary tt-choice-reset"
                  aria-label={s('choiceResetOne', { name: s(label) })}
                  onClick={() => void reset(key)}
                >
                  {s('choiceReset')}
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
