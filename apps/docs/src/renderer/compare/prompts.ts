/**
 * The texts of the AI compare feature: the prompt every website gets, the
 * cleaning of a website's answer, and the instruction for the app's own AI that
 * integrates the candidates. Pure string work.
 */

/** the instruction every website receives, word for word */
export const COMPARE_INSTRUCTION =
  'compare the English text against the original Korean text for accuracy and polish the text to make it sound more natural and refined'

/**
 * One closing line after the labelled texts. It only asks the site to answer with
 * the text itself, which keeps the candidates free of chatter without any brittle
 * parsing; the instruction above is untouched.
 */
export const COMPARE_ANSWER_ONLY =
  'Reply with the polished English text only, without any explanation.'

/** the instruction the app's own AI gets for the integration step, word for word */
export const INTEGRATE_INSTRUCTION =
  'combine the translations and produce the best version (by integrating the better elements of each, for example)'

/** the prompt sent to each website */
export function buildComparePrompt(korean: string, english: string): string {
  return [
    COMPARE_INSTRUCTION,
    '',
    'Original Korean:',
    korean.trim(),
    '',
    'English text:',
    english.trim(),
    '',
    COMPARE_ANSWER_ONLY,
  ].join('\n')
}

export interface Candidate {
  /** label shown to the model, e.g. "Gemini" */
  label: string
  text: string
}

/** the system prompt and user message of the integration step */
export function buildIntegrationRequest(input: {
  korean: string
  original: string
  answers: Candidate[]
}): { system: string; user: string } {
  const system =
    'You are a careful English editor. Reply with the final English text only: no explanation, no labels, no quotation marks around it. Candidates may contain leftover chat remarks; ignore those.'
  const parts = [INTEGRATE_INSTRUCTION, '', 'Original Korean:', input.korean.trim(), '']
  parts.push('Candidate (selected original English):', input.original.trim(), '')
  for (const answer of input.answers) {
    parts.push(`Candidate (${answer.label}):`, answer.text.trim(), '')
  }
  parts.push('Reply with the final English text only.')
  return { system, user: parts.join('\n') }
}

const LEAD_IN = /^(sure|certainly|of course|here(?:'s| is| are)|okay|ok)\b[^\n]*:\s*$/i
const LABEL_LINE =
  /^(?:\*\*)?(?:polished|revised|improved|refined|final)(?: english)?(?: text| version| translation)?(?:\*\*)?\s*:?\s*$/i
const TAIL_REMARK =
  /^(let me know|i hope|feel free|would you like|if you(?:'d| would) like|hope this|please let me know)/i

/**
 * A website's answer reduced to the text itself. Deliberately conservative: it
 * removes a code fence around the whole answer, an introductory line that ends
 * with a colon, a bare label line ("Polished version:"), closing offers of more
 * help, and one pair of quotes around the whole text. Anything else stays.
 */
export function cleanCandidate(raw: string): string {
  let lines = raw.replace(/\r\n/g, '\n').trim().split('\n')
  if (
    lines.length >= 2 &&
    /^```/.test(lines[0]!.trim()) &&
    lines[lines.length - 1]!.trim() === '```'
  ) {
    lines = lines.slice(1, -1)
  }
  while (lines.length > 0 && lines[0]!.trim() === '') lines.shift()
  if (lines.length > 1 && LEAD_IN.test(lines[0]!.trim())) lines.shift()
  while (lines.length > 0 && lines[0]!.trim() === '') lines.shift()
  if (lines.length > 1 && LABEL_LINE.test(lines[0]!.trim())) lines.shift()
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
  while (lines.length > 1 && TAIL_REMARK.test(lines[lines.length - 1]!.trim())) {
    lines.pop()
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
  }
  let text = lines.join('\n').trim()
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ['“', '”'],
  ]
  for (const [open, close] of pairs) {
    if (
      text.length > 2 &&
      text.startsWith(open) &&
      text.endsWith(close) &&
      !text.slice(1, -1).includes(open) &&
      !text.slice(1, -1).includes(close)
    ) {
      text = text.slice(1, -1).trim()
      break
    }
  }
  return text
}
