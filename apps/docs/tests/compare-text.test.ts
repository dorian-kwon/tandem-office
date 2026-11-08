import { describe, expect, it } from 'vitest'
import {
  INTEGRATE_INSTRUCTION,
  buildComparePrompt,
  buildIntegrationRequest,
  capText,
  cleanCandidate,
  languageName,
  COMPARE_TEXT_MAX_CHARS,
} from '../src/renderer/compare/prompts'
import { clampToBounds, dragPosition } from '../src/renderer/compare/drag-clamp'
import { COMPARE_SITES } from '../src/shared/compare-sites'

describe('compare prompt', () => {
  it('asks for one improved translation with the original as context', () => {
    const prompt = buildComparePrompt('안녕하세요', 'Hello there')
    expect(prompt).toContain('Improve the following English translation')
    expect(prompt).toContain('Original Korean:\n안녕하세요')
    expect(prompt).toContain('Current translation:\nHello there')
    expect(prompt).not.toContain('two sections')
  })
  it('keeps integration candidates compact and respects the target language', () => {
    const { system, user } = buildIntegrationRequest({
      korean: '',
      original: 'Original',
      targetLanguage: 'Japanese',
      answers: [
        { label: 'Copilot', text: 'Better' },
        { label: 'Connected AI', text: ' better ' },
        { label: 'Empty', text: '' },
      ],
    })
    expect(system).toContain('Japanese')
    expect(user).toContain(INTEGRATE_INSTRUCTION)
    expect(user).toContain('Candidate (Copilot):\nBetter')
    expect(user).not.toContain('Candidate (Connected AI)')
    expect(user).not.toContain('Candidate (Empty)')
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
  it('lists only Copilot as a web destination with usable site selectors', () => {
    expect(COMPARE_SITES.map((s) => s.id)).toEqual(['copilot'])
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
