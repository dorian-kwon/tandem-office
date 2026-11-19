import { DEFAULT_GLOSSARY_LIMIT, selectGlossary } from './glossary'
import type { GlossaryEntry } from './glossary'
import type { ProjectFile, TranslationChoices, WritingStyle } from './project-file'
import type { ReferenceChunk } from './reference-index'

export type ComposedItemKind = 'system' | 'project' | 'glossary' | 'reference'

export type ComposedContext = {
  text: string
  /**
   * the reference chunks picked for this request (reference-index.ts), each
   * labelled `[file — heading]`; kept apart from `text` so the caller fences
   * them as material of their own ('' when none)
   */
  referencesText: string
  /** chunks in `referencesText` */
  referenceChunks: number
  items: { kind: ComposedItemKind; label: string; included: boolean }[]
}

/**
 * Builds the context block sent with an AI request: system prompt, project prompt with the
 * language pair, the glossary entries relevant to `paragraph`, and reference file names.
 * Pure and deterministic. All inputs are plain data; no template syntax is interpreted.
 * `text` lists reference files by name only; the chunks chosen for this request (passed in
 * `references`, never read here) go to `referencesText`.
 */
export function composeContext(input: {
  systemPrompt: string
  project: ProjectFile
  glossary: GlossaryEntry[]
  paragraph: string
  glossaryLimit?: number
  references?: readonly ReferenceChunk[]
}): ComposedContext {
  const { project } = input
  const system = input.systemPrompt.trim()
  const projectPrompt = project.projectPrompt.trim()
  // the direction is fixed by the project; the language the person writes the
  // request in must never flip it
  const languageLine =
    `번역: ${project.sourceLang} → ${project.targetLang}\n` +
    `Translation direction is fixed: translate the document from ${project.sourceLang} into ${project.targetLang}. ` +
    `The language of the person's instruction (even if it is ${project.sourceLang} or any other language) never changes this; ` +
    `never translate into ${project.sourceLang}, and write the translated text in ${project.targetLang} only.`
  const styleRule = writingStyleRule(project.writingStyle)
  const choicesRule = translationChoicesRule(project.choices)
  const projectText = [projectPrompt, languageLine, styleRule, choicesRule]
    .filter((s) => s !== '')
    .join('\n')

  const selected = selectGlossary(
    input.glossary,
    input.paragraph,
    input.glossaryLimit ?? DEFAULT_GLOSSARY_LIMIT,
  )
  const glossaryLines = selected.map((e) => {
    const note = e.note ? oneLine(e.note) : ''
    return `${oneLine(e.source)} → ${oneLine(e.target)}${note ? ` (${note})` : ''}`
  })
  const glossaryText = glossaryLines.length === 0 ? '' : `단어집:\n${glossaryLines.join('\n')}`
  const references = project.references
  const referenceText =
    references.length === 0
      ? ''
      : `참고자료:\n${references.map((name) => `- ${oneLine(name)}`).join('\n')}`

  const sections = [system, projectText, glossaryText, referenceText]
  const text = sections
    .filter((s) => s !== '')
    .join('\n\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()

  const chunks = input.references ?? []
  const referencesText = chunks
    .map((c) => {
      const heading = oneLine(c.heading)
      const label = heading ? `${oneLine(c.file)} — ${heading}` : oneLine(c.file)
      return `[${label}]\n${c.text.trim()}`
    })
    .join('\n\n')

  return {
    text,
    referencesText,
    referenceChunks: chunks.length,
    items: [
      { kind: 'system', label: '시스템 프롬프트', included: system !== '' },
      { kind: 'project', label: '프로젝트 프롬프트', included: true },
      {
        kind: 'glossary',
        label: `단어집 (${selected.length}개)`,
        included: selected.length > 0,
      },
      {
        kind: 'reference',
        label: `참고자료 (${references.length}개)`,
        included: references.length > 0,
      },
    ],
  }
}

const SCOPE = 'apply only where it makes sense in the target language'

/**
 * The fixed writing-style rule for the project context ('' for the default style).
 * Short and precise; it is scoped to the target language because both choices matter
 * mostly for English.
 */
export function writingStyleRule(style: WritingStyle | undefined): string {
  if (!style) return ''
  const lines: string[] = []
  if (style.serialComma === 'with')
    lines.push(
      `- Use the serial (Oxford) comma in lists of three or more: "A, B, and C" (${SCOPE}).`,
    )
  else if (style.serialComma === 'without')
    lines.push(
      `- Do not use the serial (Oxford) comma in lists of three or more: "A, B and C" (${SCOPE}).`,
    )
  if (style.quotePunctuation === 'outside')
    lines.push(
      `- Put commas and periods outside the closing quotation mark (logical style): "A", "B" (${SCOPE}).`,
    )
  else if (style.quotePunctuation === 'inside')
    lines.push(
      `- Put commas and periods inside the closing quotation mark (American style): "A," "B," (${SCOPE}).`,
    )
  if (style.italics === 'apply')
    lines.push(
      `- Italics: wrap titles of standalone works (books, periodicals, films, plays, albums, artworks), foreign or not-yet-naturalised terms, scientific names, ship and aircraft names, and words mentioned as words in <i>…</i> inside the segment (only <i>, no nesting, never for plain emphasis; parts and articles take quotation marks) without changing the source's line breaks or other formatting; ${SCOPE}, e.g. nothing for Korean, Chinese or Japanese.`,
    )
  else if (style.italics === 'off') lines.push('- Do not add italics of your own (no <i> tags).')
  const custom = oneLine(style.custom ?? '')
  if (custom !== '') lines.push(`- Custom instruction: ${custom}`)
  // the style is for the text being translated; a review must not rewrite a correct
  // translation only to enforce it
  return lines.length === 0
    ? ''
    : `Writing style (applies when you translate; when reviewing, do not change correct text only to enforce it):\n${lines.join('\n')}`
}

/**
 * The answers the person kept for this project (output mode, bilingual layout, OCR
 * placement) as short rules, and for every question not answered yet one line telling the
 * AI to ask with ask_choice before writing. The layout line is conditional because only the
 * output mode "keep the original" needs a layout. Always non-empty: an undecided project
 * must make the AI ask.
 */
export function translationChoicesRule(choices: TranslationChoices | undefined): string {
  const c = choices ?? {}
  const decided: string[] = []
  if (c.outputMode) decided.push(`- Output mode: ${oneLine(c.outputMode)}`)
  if (c.bilingual) decided.push(`- Bilingual layout: ${oneLine(c.bilingual)}`)
  if (c.ocrPlacement)
    decided.push(
      `- OCR placement: ${oneLine(c.ocrPlacement)} (editable Word or spreadsheet placement only; for a PDF, HWP or HWPX new-docx result, ask only for plain confirmation of the proposed output file).`,
    )
  const ask: string[] = []
  if (!c.outputMode)
    ask.push(
      '- Output mode is not decided: ask with ask_choice before writing (remember key "outputMode"): overwrite the output copy\'s text with the translation, or keep the original and add the translation beside it.',
    )
  if (!c.bilingual)
    ask.push(
      '- Bilingual layout is not decided: if the output mode keeps the original, ask with ask_choice before writing (remember key "bilingual"): translation in a new paragraph after the original, or original in parentheses after the translated term; adapt the options to this editor. Table cells are asked separately (see below).',
    )
  if (!c.ocrPlacement)
    ask.push(
      '- OCR placement is not decided: ask with ask_choice for editable Word or spreadsheet placement (remember key "ocrPlacement"). For new-docx (PDF/HWP/HWPX), confirm the proposed file in plain text.',
    )
  // tables are asked every time, never remembered: the person picks the direction per document
  ask.push(
    '- Keeping the original (bilingual): in a Word document use add_bilingual, never translate_blocks or replace_blocks. For a table, ask with ask_choice EVERY time, without a remember key: right cell (left original, right translation) or below cell (top original, bottom translation), as a new column/row (layout "right"/"below") or an existing empty cell next to the original, or somewhere else the person types (target {kind:"cell",index,row,column} per entry; read_runs shows cells and the empty ones). When the person says where, follow it literally.',
  )
  const head =
    decided.length > 0
      ? 'Translation choices (decided by the person; follow them, never invent your own):'
      : 'Translation choices (none decided yet):'
  return [head, ...decided, ...ask].join('\n')
}

/** Collapses any whitespace run containing a line break so a value stays on one prompt line. */
function oneLine(value: string): string {
  return value.replace(/\s*[\r\n]+\s*/g, ' ').trim()
}
