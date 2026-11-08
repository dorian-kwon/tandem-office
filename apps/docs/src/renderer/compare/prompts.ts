/**
 * The texts of the AI compare feature: the prompt every website gets, the
 * cleaning of a website's answer, and the instruction for the app's own AI that
 * integrates the candidates. Pure string work.
 */

export const INTEGRATE_INSTRUCTION = 'Combine the candidates into one best translation.'

/** the most characters of the selection (and of an added original) that are sent to the sites */
export const COMPARE_TEXT_MAX_CHARS = 4000

/** `text` cut to `max` characters; `cut` tells that something was left out */
export function capText(
  text: string,
  max = COMPARE_TEXT_MAX_CHARS,
): { text: string; cut: boolean } {
  const trimmed = text.trim()
  return trimmed.length > max
    ? { text: trimmed.slice(0, max).trimEnd(), cut: true }
    : { text: trimmed, cut: false }
}

/**
 * The English name of a language code, for the prompt ("ko" gives "Korean", "zh-TW" gives
 * "Traditional Chinese"). An unknown code stays as it is.
 */
export function languageName(code: string): string {
  const c = code.trim()
  const lower = c.toLowerCase()
  if (lower === 'zh' || lower === 'zh-cn' || lower === 'zh-hans') return 'Simplified Chinese'
  if (lower === 'zh-tw' || lower === 'zh-hk' || lower === 'zh-hant') return 'Traditional Chinese'
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(c) ?? c
  } catch {
    return c
  }
}

export interface PromptOptions {
  targetLanguage?: string
}

/** Each engine gets one translation or improvement task and returns one answer. */
export function buildComparePrompt(
  korean: string,
  text: string,
  options: PromptOptions = {},
): string {
  const target = options.targetLanguage?.trim() || 'English'
  const selection = text.trim()
  const koreanSource = /\p{Script=Hangul}/u.test(selection)
  if (koreanSource || !korean.trim())
    return [
      `Translate the following text into ${target}. Return only one finished translation, without explanation.`,
      '',
      selection,
    ].join('\n')
  const parts = [
    `Improve the following ${target} translation for accuracy and natural wording. Return only one finished translation, without explanation.`,
    '',
  ]
  if (korean.trim()) parts.push('Original Korean:', korean.trim(), '')
  parts.push('Current translation:', selection)
  return parts.join('\n')
}

export interface Candidate {
  /** engine label shown to the model */
  label: string
  text: string
}

const normalized = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase()

/** the system prompt and user message of the integration step */
export function buildIntegrationRequest(input: {
  korean: string
  original: string
  answers: Candidate[]
  /** without an original: the language all candidates are in (English name) */
  targetLanguage?: string
}): { system: string; user: string } {
  const target = input.targetLanguage?.trim() || 'English'
  const system = `You are a careful translation editor. Reply with one final ${target} text only, without explanation or labels.`
  const parts = [INTEGRATE_INSTRUCTION, '']
  if (input.korean.trim() !== '') parts.push('Original Korean:', input.korean.trim(), '')
  if (input.targetLanguage) parts.push(`Target language: ${input.targetLanguage}`, '')
  parts.push('Candidate (selected original text):', input.original.trim(), '')
  // compact: empty candidates and texts identical to an earlier one (or to the original) are left out
  const seen = new Set([normalized(input.original)])
  for (const answer of input.answers) {
    const key = normalized(answer.text)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    parts.push(`Candidate (${answer.label}):`, answer.text.trim(), '')
  }
  parts.push(`Reply with one final ${target} text only.`)
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
