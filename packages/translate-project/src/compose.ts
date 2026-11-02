import { DEFAULT_GLOSSARY_LIMIT, selectGlossary } from './glossary'
import type { GlossaryEntry } from './glossary'
import type { ProjectFile } from './project-file'

export type ComposedItemKind = 'system' | 'project' | 'glossary' | 'reference'

export type ComposedContext = {
  text: string
  items: { kind: ComposedItemKind; label: string; included: boolean }[]
}

/**
 * Builds the context block sent with an AI request: system prompt, project prompt with the
 * language pair, the glossary entries relevant to `paragraph`, and reference file names.
 * Pure and deterministic. All inputs are plain data; no template syntax is interpreted, and
 * reference materials are listed by name only (their contents are never available here).
 */
export function composeContext(input: {
  systemPrompt: string
  project: ProjectFile
  glossary: GlossaryEntry[]
  paragraph: string
  glossaryLimit?: number
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

  return {
    text,
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
