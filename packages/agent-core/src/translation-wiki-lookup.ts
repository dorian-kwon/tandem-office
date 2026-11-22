import type { AgentToolDef } from './types'

export const TRANSLATION_EXAMPLE_LOOKUP = 'project_lookup_translation_examples'

const axes = {
  industry: 'Industry supported by the subject matter, e.g. tourism or healthcare.',
  documentType: 'Document genre supported by the structure, e.g. guide, report or contract.',
  institution: 'Commissioning or issuing institution explicitly named in the source.',
  style: 'Writing style demonstrated by the passages, e.g. formal, instructional or promotional.',
}
export type TranslationWikiCategories = Partial<Record<keyof typeof axes, string>>

export const translationCategorySchema = {
  type: 'object',
  description:
    'Classify this source using its text. Omit axes without evidence; use {} when none are supported.',
  properties: Object.fromEntries(
    Object.entries(axes).map(([key, description]) => [
      key,
      { type: 'string', maxLength: 120, description },
    ]),
  ),
  additionalProperties: false,
}

export const translationExampleLookupTool: AgentToolDef = {
  name: TRANSLATION_EXAMPLE_LOOKUP,
  description:
    'Look up translation examples from the local translation wiki using categories supported by the current source. With categories {} you can consult index.md or follow a link to another Markdown note by its wiki-relative path. With source-supported labels the result gives matching examples and their source notes.',
  inputSchema: {
    type: 'object',
    properties: {
      categories: translationCategorySchema,
      path: {
        type: 'string',
        description:
          'Optional wiki-relative Markdown path from a link, e.g. index.md or categories/Tourism.md. Use with categories {}.',
      },
    },
    required: ['categories'],
    additionalProperties: false,
  },
}

export function translationWikiCategories(value: unknown): TranslationWikiCategories | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const categories: TranslationWikiCategories = {}
  for (const [key, label] of Object.entries(value)) {
    if (
      !Object.hasOwn(axes, key) ||
      typeof label !== 'string' ||
      label.length > 120 ||
      !label.trim()
    )
      return null
    categories[key as keyof typeof axes] = label.trim()
  }
  return categories
}
