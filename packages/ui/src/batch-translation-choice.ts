import type { BatchTranslationChoices } from '@genoffice/project-store/editor-run'
import type { ChoiceQuestion } from './ai-choice'

const formats = {
  'target-only': ['outputMode', 'Translate the text in the output copy. Preserve the source file.'],
  bilingual: ['outputMode', 'Keep the original text alongside its translation in the output copy.'],
  'new-paragraph': ['bilingual', 'Add the translation in a new paragraph after the original.'],
  parentheses: ['bilingual', 'Place the original in parentheses beside the translation.'],
  'right-cell': [
    'tableLayout',
    'Keep the original cell and put its translation in a column to its right.',
  ],
  'below-cell': [
    'tableLayout',
    'Keep the original cell and put its translation in a row below it.',
  ],
  'source-style': ['style', 'Match the source tone and the project style instructions.'],
} as const

export const batchTranslationFormats = Object.keys(formats)

const defaults = {
  outputMode: 'target-only',
  bilingual: 'new-paragraph',
  tableLayout: 'right-cell',
  style: 'source-style',
} as const

// Older prompts only list the available options, with the most likely first.
// Recognize common labels, but return our own formatting instruction, never the model's text.
function knownOption(label: string): keyof typeof formats | undefined {
  const text = label
    .toLowerCase()
    .replace(/\s*[（(](?:recommended|추천|권장)[)）]\s*/gu, '')
    .trim()
  if (
    /^(?:bilingual|keep both languages|keep the original and add the translation|병기(?: 번역)?|원문과 번역문 병기)$/u.test(
      text,
    )
  )
    return 'bilingual'
  if (
    /^(?:target[- ]only|translation only|translate the output copy|번역문만|번역문으로 대체)$/u.test(
      text,
    )
  )
    return 'target-only'
  if (/^(?:new paragraph|below the original|새 문단|다음 문단)$/u.test(text)) return 'new-paragraph'
  if (/^(?:parentheses|in parentheses|괄호|괄호 병기)$/u.test(text)) return 'parentheses'
  if (/^(?:right cell|column to the right|right column|오른쪽 셀|오른쪽 열)$/u.test(text))
    return 'right-cell'
  if (/^(?:below cell|row below|아래 셀|아래 행)$/u.test(text)) return 'below-cell'
  return undefined
}

/** Return a local formatting instruction, never an arbitrary model-proposed option or a human confirmation. */
export function batchTranslationChoice(
  question: ChoiceQuestion,
  recommendation: unknown,
  project: BatchTranslationChoices,
): string | null {
  const id = question.remember?.key ?? question.id
  if (id === 'ocrPlacement') return null
  const labels = question.options.map(knownOption)
  const first = labels[0]
  const matchingLabels =
    first && labels.every((label) => label && formats[label][0] === formats[first][0])
  const selected =
    typeof recommendation === 'string' && Object.hasOwn(formats, recommendation)
      ? (recommendation as keyof typeof formats)
      : matchingLabels
        ? first
        : undefined
  const format = selected ? formats[selected] : undefined
  const kind = Object.hasOwn(defaults, id)
    ? (id as keyof typeof defaults)
    : matchingLabels
      ? formats[first][0]
      : undefined
  if (!kind) return null
  const saved = (kind === 'outputMode' || kind === 'bilingual') && project[kind]
  const setting = saved || (format?.[0] === kind ? format[1] : formats[defaults[kind]][1])
  return `Batch translation formatting (${kind}): ${setting} Continue translating the output document. This selection only sets the translation format.`
}
