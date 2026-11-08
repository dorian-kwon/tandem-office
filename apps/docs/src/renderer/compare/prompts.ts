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

/** the section markers a re-translating site is asked to answer with */
export const MARKER_POLISHED = '[POLISHED]'
export const MARKER_RETRANSLATION = '[RETRANSLATION]'

/**
 * The extra instruction when the sites also re-translate the Korean original. It asks for an
 * independent translation (the given English must not be looked at) and for exactly two
 * marked sections, so the reply can be split by the markers without guessing.
 */
export const COMPARE_RETRANSLATE_INSTRUCTION = [
  'Also translate the original Korean text into English yourself, independently: do not look at the given English text while doing this.',
  '',
  `Answer in exactly two sections. Start the first with the line ${MARKER_POLISHED} followed by the polished English text only, then start the second with the line ${MARKER_RETRANSLATION} followed by your own fresh English translation only. No commentary, no quotes, no markdown.`,
].join('\n')

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
  /** with an original: the sites also translate it themselves and answer in two marked sections */
  retranslate?: boolean
  /** without an original: the language the selection is translated into (English name) */
  targetLanguage?: string
}

/**
 * The prompt sent to each website, one builder for two modes.
 * With an original (`korean` not empty): the polishing instruction, the labelled original and
 * English, and either the answer-only line or (`retranslate`) the re-translation instruction.
 * Without: only the selection, to be translated into the target language, or re-translated when
 * it already is in it; the site detects the source language itself.
 */
export function buildComparePrompt(
  korean: string,
  english: string,
  options: PromptOptions = {},
): string {
  if (korean.trim() === '') {
    const target = options.targetLanguage?.trim() || 'English'
    return [
      `Translate the following text into ${target}. If it is already in ${target}, re-translate it so that it is accurate, natural and refined. Answer with the resulting text only.`,
      '',
      english.trim(),
    ].join('\n')
  }
  return [
    COMPARE_INSTRUCTION,
    '',
    'Original Korean:',
    korean.trim(),
    '',
    'English text:',
    english.trim(),
    '',
    options.retranslate ? COMPARE_RETRANSLATE_INSTRUCTION : COMPARE_ANSWER_ONLY,
  ].join('\n')
}

export type CandidateKind = 'polished' | 'retranslation'

export interface Candidate {
  /** label shown to the model, e.g. "Gemini (polished)" */
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
  const system =
    'You are a careful English editor. Reply with the final English text only: no explanation, no labels, no quotation marks around it. Candidates may contain leftover chat remarks; ignore those.'
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
  parts.push('Reply with the final English text only.')
  return { system, user: parts.join('\n') }
}

export interface SplitAnswer {
  /** the polished English, cleaned; '' when the reply has none */
  polished: string
  /** the site's own fresh translation, cleaned; '' when the reply has none */
  retranslation: string
}

const MARKER_LINE = /^[\s>*_#`-]*\[(POLISHED|RETRANSLATION)\][\s*_:`-]*(.*)$/i

/**
 * A site's reply split into its two sections by the markers. Never fails: without any marker
 * (or when re-translation is off) the whole reply is the polished text; with one marker, what
 * follows it is that section (an earlier unmarked part is chatter and is dropped); the order
 * of the sections does not matter; a repeated marker keeps the first filled section.
 * Each section goes through the same cleaning as any single answer.
 */
export function splitAnswer(raw: string, retranslate: boolean): SplitAnswer {
  if (!retranslate) return { polished: cleanCandidate(raw), retranslation: '' }
  const lines = raw.replace(/\r\n/g, '\n').split('\n')
  const sections: Record<'polished' | 'retranslation', string[]> = {
    polished: [],
    retranslation: [],
  }
  let current: 'polished' | 'retranslation' | null = null
  let sawMarker = false
  for (const line of lines) {
    const marker = MARKER_LINE.exec(line)
    if (marker) {
      sawMarker = true
      const name = marker[1]!.toUpperCase() === 'POLISHED' ? 'polished' : 'retranslation'
      // a second marker of an already filled section is ignored together with its text
      current = sections[name].some((l) => l.trim() !== '') ? null : name
      if (current && marker[2]!.trim() !== '') sections[current].push(marker[2]!)
      continue
    }
    if (current) sections[current].push(line)
  }
  if (!sawMarker) return { polished: cleanCandidate(raw), retranslation: '' }
  return {
    polished: cleanCandidate(sections.polished.join('\n')),
    retranslation: cleanCandidate(sections.retranslation.join('\n')),
  }
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
