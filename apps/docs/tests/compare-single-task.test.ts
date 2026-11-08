import { describe, expect, it } from 'vitest'
import { buildComparePrompt, buildIntegrationRequest } from '../src/renderer/compare/prompts'

describe('one comparison task per engine', () => {
  it('asks only for translation of Korean text into the chosen target', () => {
    const prompt = buildComparePrompt('원문 맥락', '선택한 한국어 원문', {
      targetLanguage: 'Japanese',
    })
    expect(prompt).toContain('Translate the following text into Japanese.')
    expect(prompt).toContain('선택한 한국어 원문')
    expect(prompt).not.toMatch(/POLISHED|RETRANSLATION|two sections|independently|re-translate/)
    expect(prompt).not.toContain('원문 맥락')
  })
  it('asks for one improved translation with source context when the selection is translated text', () => {
    const prompt = buildComparePrompt('한국어 원문', 'Existing translation', {
      targetLanguage: 'French',
    })
    expect(prompt).toContain('Improve the following French translation')
    expect(prompt).toContain('한국어 원문')
    expect(prompt).toContain('Existing translation')
    expect(prompt).not.toMatch(/POLISHED|RETRANSLATION|two sections|independently|re-translate/)
  })
  it.each(['Bonjour le monde', '你好世界'])(
    'does not assume a no-source selection is already English: %s',
    (text) => {
      const prompt = buildComparePrompt('', text)
      expect(prompt).toContain('Translate the following text into English.')
      expect(prompt).toContain(text)
      expect(prompt).not.toContain('Improve')
    },
  )
  it('defaults Korean translation to English without relying on the UI language', () => {
    expect(buildComparePrompt('', '한국어 원문')).toContain(
      'Translate the following text into English.',
    )
  })
  it('integrates into the chosen language without forcing English', () => {
    const request = buildIntegrationRequest({
      korean: '원문',
      original: 'Texte',
      answers: [{ label: 'Copilot', text: 'Réponse' }],
      targetLanguage: 'French',
    })
    expect(request.system).toContain('French')
    expect(request.system).not.toContain('final English')
    expect(request.user).toContain('Copilot')
  })
})
