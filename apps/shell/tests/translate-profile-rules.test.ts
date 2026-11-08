import { describe, expect, it } from 'vitest'
import { translationChoicesRule, writingStyleRule } from '@genoffice/translate-project'
import { TRANSLATION_EDITING_RULES } from '../src/main/translate/context-injection'
import { TRANSLATION_DROPPED_TOOLS } from '../../docs/src/renderer/ai/translation-profile'

/**
 * The translation context names tools by their snake_case name. The Word
 * editor's translation profile withholds some tools, so no rule may send the
 * model to one of them.
 */
describe('translation context vs the translation tool profile', () => {
  const rules = [
    TRANSLATION_EDITING_RULES,
    writingStyleRule({
      serialComma: 'with',
      quotePunctuation: 'outside',
      italics: 'apply',
      custom: 'keep it short',
    }),
    translationChoicesRule(undefined),
    translationChoicesRule({ outputMode: 'overwrite', bilingual: 'after', ocrPlacement: 'below' }),
  ]

  it('names no tool the profile drops', () => {
    for (const rule of rules) {
      for (const name of TRANSLATION_DROPPED_TOOLS) {
        expect(rule, name).not.toMatch(new RegExp(`\\b${name}\\b`))
      }
    }
  })

  it('still names the tools it depends on', () => {
    const text = rules.join('\n')
    for (const name of [
      'read_runs',
      'translate_blocks',
      'add_bilingual',
      'revise_blocks',
      'ask_choice',
    ])
      expect(text).toContain(name)
  })
})
