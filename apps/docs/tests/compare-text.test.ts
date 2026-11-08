import { describe, expect, it } from 'vitest'
import {
  COMPARE_ANSWER_ONLY,
  COMPARE_INSTRUCTION,
  INTEGRATE_INSTRUCTION,
  buildComparePrompt,
  buildIntegrationRequest,
  capText,
  cleanCandidate,
  languageName,
  splitAnswer,
  COMPARE_TEXT_MAX_CHARS,
} from '../src/renderer/compare/prompts'
import { clampToBounds, dragPosition } from '../src/renderer/compare/drag-clamp'
import { COMPARE_SITES } from '../src/shared/compare-sites'

describe('compare prompt', () => {
  it('is the exact instruction followed by the labelled Korean and English texts', () => {
    const prompt = buildComparePrompt(' 안녕하세요 ', ' Hello there ')
    expect(
      prompt.startsWith(
        `${COMPARE_INSTRUCTION}\n\nOriginal Korean:\n안녕하세요\n\nEnglish text:\nHello there`,
      ),
    ).toBe(true)
    expect(prompt.endsWith(COMPARE_ANSWER_ONLY)).toBe(true)
    expect(COMPARE_INSTRUCTION).toBe(
      'compare the English text against the original Korean text for accuracy and polish the text to make it sound more natural and refined',
    )
  })

  it('integration request carries the exact instruction and every candidate labelled', () => {
    const { system, user } = buildIntegrationRequest({
      korean: '원문',
      original: 'Original English',
      answers: [
        { label: 'Gemini', text: 'G text' },
        { label: 'Copilot', text: 'C text' },
      ],
    })
    expect(INTEGRATE_INSTRUCTION).toBe(
      'combine the translations and produce the best version (by integrating the better elements of each, for example)',
    )
    expect(user.startsWith(INTEGRATE_INSTRUCTION)).toBe(true)
    expect(user).toContain('Original Korean:\n원문')
    expect(user).toContain('Candidate (selected original text):\nOriginal English')
    expect(user).toContain('Candidate (Gemini):\nG text')
    expect(user).toContain('Candidate (Copilot):\nC text')
    expect(system).toMatch(/final English text only/)
  })

  it('without an original the prompt is the selection only, aimed at the target language', () => {
    const prompt = buildComparePrompt('', ' 매출이 늘었다. ', { targetLanguage: 'Japanese' })
    expect(prompt).toBe(
      'Translate the following text into Japanese. If it is already in Japanese, re-translate it so that it is accurate, natural and refined. Answer with the resulting text only.\n\n매출이 늘었다.',
    )
    expect(buildComparePrompt('  ', 'x')).toContain('into English.')
    // the integration request then has no Korean section but names the language
    const { user } = buildIntegrationRequest({
      korean: '',
      original: 'o',
      answers: [{ label: 'Gemini (polished)', text: 'g' }],
      targetLanguage: 'Japanese',
    })
    expect(user).not.toContain('Original Korean:')
    expect(user).toContain('Target language: Japanese')
  })

  it('with an original and re-translation on, the polish sentence stays and two sections are asked for', () => {
    const prompt = buildComparePrompt('원문', 'Text', { retranslate: true })
    expect(prompt.startsWith(COMPARE_INSTRUCTION)).toBe(true)
    expect(prompt).toContain('Original Korean:\n원문\n\nEnglish text:\nText')
    expect(prompt).toContain('translate the original Korean text into English yourself')
    expect(prompt).toContain('do not look at the given English text')
    expect(prompt).toContain('[POLISHED]')
    expect(prompt).toContain('[RETRANSLATION]')
    expect(prompt).not.toContain(COMPARE_ANSWER_ONLY)
  })

  it('names languages in English from their codes and caps long text', () => {
    expect(languageName('ko')).toBe('Korean')
    expect(languageName('ja')).toBe('Japanese')
    expect(languageName('en')).toBe('English')
    expect(languageName('zh')).toBe('Simplified Chinese')
    expect(languageName('zh-TW')).toBe('Traditional Chinese')
    expect(capText('  short  ')).toEqual({ text: 'short', cut: false })
    const c = capText('a'.repeat(5000))
    expect(c.cut).toBe(true)
    expect(c.text).toHaveLength(COMPARE_TEXT_MAX_CHARS)
  })

  it('integration keeps up to 8 candidates compact: no empty text, no duplicates, none equal to the original', () => {
    const answers = [
      { label: 'Gemini (polished)', text: 'Better text.' },
      { label: 'Gemini (re-translated)', text: '  better   TEXT. ' },
      { label: 'Claude (polished)', text: '' },
      { label: 'Claude (re-translated)', text: 'Original English' },
      { label: 'Copilot (polished)', text: 'Another one.' },
    ]
    const { user } = buildIntegrationRequest({
      korean: '원문',
      original: 'Original English',
      answers,
    })
    expect(user.match(/Candidate \(/g)).toHaveLength(3)
    expect(user).toContain('Candidate (Gemini (polished)):')
    expect(user).not.toContain('Gemini (re-translated)')
    expect(user).not.toContain('Claude')
    expect(user).toContain('Candidate (Copilot (polished)):')
  })
})

describe('splitAnswer', () => {
  const both = '[POLISHED]\nPolished text.\n[RETRANSLATION]\nFresh text.'
  it('splits two markers', () => {
    expect(splitAnswer(both, true)).toEqual({
      polished: 'Polished text.',
      retranslation: 'Fresh text.',
    })
  })
  it('takes whatever follows a single marker; chatter before it is dropped', () => {
    expect(splitAnswer('Sure thing!\n[RETRANSLATION]\nOnly fresh.', true)).toEqual({
      polished: '',
      retranslation: 'Only fresh.',
    })
    expect(splitAnswer('Intro\n[POLISHED]\nOnly polished.', true)).toEqual({
      polished: 'Only polished.',
      retranslation: '',
    })
  })
  it('no marker: everything is the polished text; off: never split', () => {
    expect(splitAnswer('Just text\nmore', true)).toEqual({
      polished: 'Just text\nmore',
      retranslation: '',
    })
    expect(splitAnswer(both, false).polished).toContain('[RETRANSLATION]')
    expect(splitAnswer(both, false).retranslation).toBe('')
  })
  it('reversed order, bold/colon markers, inline text after a marker', () => {
    expect(splitAnswer('**[RETRANSLATION]**\nFresh.\n**[POLISHED]:** Polished.', true)).toEqual({
      polished: 'Polished.',
      retranslation: 'Fresh.',
    })
  })
  it('strips code fences, quotes and tail chatter inside each section', () => {
    const raw =
      '[POLISHED]\n```\nPolished.\n```\n[RETRANSLATION]\n"Fresh."\n\nLet me know if you want more!'
    expect(splitAnswer(raw, true)).toEqual({ polished: 'Polished.', retranslation: 'Fresh.' })
  })
  it('empty sections stay empty and a repeated marker keeps the first filled section', () => {
    expect(splitAnswer('[POLISHED]\n\n[RETRANSLATION]\nFresh.', true)).toEqual({
      polished: '',
      retranslation: 'Fresh.',
    })
    expect(
      splitAnswer('[POLISHED]\nFirst.\n[RETRANSLATION]\nR.\n[POLISHED]\nSecond.', true).polished,
    ).toBe('First.')
  })
})

describe('cleanCandidate', () => {
  it('leaves a plain answer alone', () => {
    expect(cleanCandidate('  The quick brown fox.\nSecond line.  ')).toBe(
      'The quick brown fox.\nSecond line.',
    )
  })
  it('drops a lead-in line, a label line and closing offers', () => {
    expect(
      cleanCandidate(
        'Sure, here is the polished version:\n\nPolished version:\nThe text.\n\nLet me know if you want more!',
      ),
    ).toBe('The text.')
  })
  it('unwraps a code fence and one pair of quotes', () => {
    expect(cleanCandidate('```\nThe text.\n```')).toBe('The text.')
    expect(cleanCandidate('“The text.”')).toBe('The text.')
    expect(cleanCandidate('"He said "no" twice."')).toBe('"He said "no" twice."')
  })
  it('keeps a single line even if it looks like a lead-in', () => {
    expect(cleanCandidate('Here is the thing:')).toBe('Here is the thing:')
  })
})

describe('drag clamp', () => {
  const bounds = { left: 0, top: 100, width: 800, height: 500 }
  const size = { width: 300, height: 200 }
  it('keeps the popup inside the editor area, never above the ribbon', () => {
    expect(clampToBounds({ left: -50, top: 10 }, size, bounds)).toEqual({ left: 0, top: 100 })
    expect(clampToBounds({ left: 900, top: 900 }, size, bounds)).toEqual({ left: 500, top: 400 })
    expect(clampToBounds({ left: 120, top: 150 }, size, bounds)).toEqual({ left: 120, top: 150 })
  })
  it('pins an oversized popup to the top-left corner', () => {
    expect(clampToBounds({ left: 50, top: 50 }, { width: 1000, height: 900 }, bounds)).toEqual({
      left: 0,
      top: 100,
    })
  })
  it('a drag moves by the pointer delta and is clamped', () => {
    const start = { left: 200, top: 200 }
    expect(dragPosition(start, { left: 10, top: 10 }, { left: 40, top: 30 }, size, bounds)).toEqual(
      {
        left: 230,
        top: 220,
      },
    )
    expect(
      dragPosition(start, { left: 10, top: 10 }, { left: 10, top: -500 }, size, bounds),
    ).toEqual({
      left: 200,
      top: 100,
    })
  })
})

describe('site table', () => {
  it('reopen-strategy sites name their sidebar link; prepare steps are valid data', () => {
    for (const site of COMPARE_SITES) {
      if (site.readStrategy === 'reopen') expect(site.reopenLinkSelector).toBeTruthy()
      for (const step of site.prepare ?? []) {
        expect(step.open.trim()).not.toBe('')
        expect(step.items.trim()).not.toBe('')
        expect(() => new RegExp(step.match, 'i')).not.toThrow()
        expect(() => new RegExp(step.exclude, 'i')).not.toThrow()
      }
    }
    const gemini = COMPARE_SITES.find((s) => s.id === 'gemini')!
    // a real mouse click on the send button makes the live view show the answer
    expect(gemini.readStrategy).toBe('live')
    // the mode step picks Pro (the only mode that answered on the owner's account), not Lite
    const step = gemini.prepare![0]!
    const wanted = (text: string) =>
      new RegExp(step.match, 'i').test(text) && !new RegExp(step.exclude, 'i').test(text)
    expect(wanted('3.1 Pro')).toBe(true)
    expect(wanted('3.6 Flash')).toBe(false)
    expect(wanted('3.8 사고 모델')).toBe(false)
    expect(COMPARE_SITES.filter((s) => s.readStrategy === 'live').length).toBe(4)
  })

  it('lists Gemini, Claude, Copilot and Grok symmetrically; all four are verified on the real sites', () => {
    expect(COMPARE_SITES.map((s) => s.id)).toEqual(['gemini', 'claude', 'copilot', 'grok'])
    for (const site of COMPARE_SITES) {
      expect(site.verified).toBe(true)
      expect(site.url).toMatch(/^https:\/\//)
      for (const field of [site.inputSelector, site.submitSelector, site.answerSelector])
        expect(field.trim()).not.toBe('')
      expect(() => new RegExp(site.loginHint, 'i')).not.toThrow()
      expect(() => new RegExp(site.loggedOutUrl, 'i')).not.toThrow()
      // a site may have no stop button: its answer then counts as complete when the text settles
      expect(typeof site.busySelector).toBe('string')
      expect(['insertText', 'paste', 'fill']).toContain(site.inputMode)
    }
  })
})
