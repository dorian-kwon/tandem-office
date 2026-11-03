import { DEFAULT_GLOSSARY_LIMIT, selectGlossary } from './glossary'
import type { GlossaryEntry } from './glossary'
import type { ProjectFile } from './project-file'
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
  const projectText = projectPrompt === '' ? languageLine : `${projectPrompt}\n${languageLine}`

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

/** Collapses any whitespace run containing a line break so a value stays on one prompt line. */
function oneLine(value: string): string {
  return value.replace(/\s*[\r\n]+\s*/g, ' ').trim()
}
