import { useState } from 'react'
import type { QuotePunctuation, SerialComma, WritingStyle } from '@genoffice/translate-project'
import type { TranslateStringKey } from '../i18n/strings-translate'

/** What a project without a stored choice shows (the package default; the renderer cannot import it). */
export const DEFAULT_WRITING_STYLE: WritingStyle = {
  serialComma: 'default',
  quotePunctuation: 'default',
  custom: '',
}

type Text = (key: TranslateStringKey) => string

type Option<V extends string> = {
  value: V
  label: TranslateStringKey
  example: TranslateStringKey
}

const SERIAL_OPTIONS: Option<SerialComma>[] = [
  { value: 'with', label: 'serialWith', example: 'exSerialWith' },
  { value: 'without', label: 'serialWithout', example: 'exSerialWithout' },
  { value: 'default', label: 'styleFollow', example: 'exFollow' },
]

const QUOTE_OPTIONS: Option<QuotePunctuation>[] = [
  { value: 'outside', label: 'quoteOutside', example: 'exQuoteOutside' },
  { value: 'inside', label: 'quoteInside', example: 'exQuoteInside' },
  { value: 'default', label: 'styleFollow', example: 'exFollow' },
]

/** One question: numbered options (1, 2, 3), each with a small example line. */
function Question<V extends string>({
  name,
  legend,
  options,
  value,
  onPick,
  s,
}: {
  name: string
  legend: string
  options: Option<V>[]
  value: V
  onPick: (value: V) => void
  s: Text
}) {
  return (
    <fieldset className="tt-question" data-style-question={name}>
      <legend className="tt-question-legend">{legend}</legend>
      {options.map((option, index) => (
        <label
          key={option.value}
          className={`tt-option${option.value === value ? ' is-selected' : ''}`}
          data-style-option={`${name}:${option.value}`}
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={option.value === value}
            onChange={() => onPick(option.value)}
          />
          <span className="tt-option-num" aria-hidden="true">
            {index + 1}
          </span>
          <span className="tt-option-text">
            <span className="tt-option-label">{s(option.label)}</span>
            <span className="tt-option-example">{s(option.example)}</span>
          </span>
        </label>
      ))}
    </fieldset>
  )
}

/**
 * The project's writing style: serial comma, comma/period placement with quotation marks,
 * and a free instruction. Choices save at once; the text saves when you leave the field.
 */
export function WritingStyleCard({
  style,
  onSave,
  s,
}: {
  style: WritingStyle
  /** resolves true when saved */
  onSave: (next: WritingStyle) => Promise<boolean>
  s: (key: TranslateStringKey) => string
}) {
  const [custom, setCustom] = useState(style.custom)
  const [state, setState] = useState<'idle' | 'saved' | 'failed'>('idle')

  const save = async (next: WritingStyle) => {
    const ok = await onSave(next)
    setState(ok ? 'saved' : 'failed')
  }

  return (
    <section className="translate-card-section tt-style-card" data-style-card>
      <div className="translate-field-head">
        <h3 className="translate-section-title">{s('styleTitle')}</h3>
        {state === 'saved' && (
          <span className="translate-saved" role="status">
            {s('saved')}
          </span>
        )}
        {state === 'failed' && (
          <span className="translate-saved is-failed" role="status">
            {s('promptNotSaved')}
          </span>
        )}
      </div>
      <p className="projects-hint">{s('styleHint')}</p>
      <div className="tt-questions">
        <Question
          name="serialComma"
          legend={s('serialCommaLabel')}
          options={SERIAL_OPTIONS}
          value={style.serialComma}
          onPick={(serialComma) => void save({ ...style, custom, serialComma })}
          s={s}
        />
        <Question
          name="quotePunctuation"
          legend={s('quoteLabel')}
          options={QUOTE_OPTIONS}
          value={style.quotePunctuation}
          onPick={(quotePunctuation) => void save({ ...style, custom, quotePunctuation })}
          s={s}
        />
      </div>
      <label className="projects-field tt-custom">
        <span className="projects-field-label">{s('styleCustomLabel')}</span>
        <input
          type="text"
          value={custom}
          maxLength={500}
          placeholder={s('styleCustomPlaceholder')}
          aria-label={s('styleCustomLabel')}
          onChange={(e) => {
            setCustom(e.target.value)
            setState('idle')
          }}
          onBlur={() => {
            if (custom !== style.custom) void save({ ...style, custom })
          }}
        />
      </label>
    </section>
  )
}
