import { DEFAULT_GLOSSARY_LIMIT, selectGlossary } from './glossary'
import type { GlossaryEntry } from './glossary'
import type { ProjectFile, WritingStyle } from './project-file'
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
  const languageLine = `번역: ${project.sourceLang} → ${project.targetLang}`
  const styleRule = writingStyleRule(project.writingStyle)
  const projectText = [projectPrompt, languageLine, styleRule].filter((s) => s !== '').join('\n')

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
    lines.push(`- Use the serial (Oxford) comma in lists of three or more: "A, B, and C" (${SCOPE}).`)
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
  const custom = oneLine(style.custom ?? '')
  if (custom !== '') lines.push(`- Custom instruction: ${custom}`)
  return lines.length === 0 ? '' : `Writing style:\n${lines.join('\n')}`
}

/** Collapses any whitespace run containing a line break so a value stays on one prompt line. */
function oneLine(value: string): string {
  return value.replace(/\s*[\r\n]+\s*/g, ' ').trim()
}
