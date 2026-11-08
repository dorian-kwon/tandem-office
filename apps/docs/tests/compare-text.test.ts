import { describe, expect, it } from 'vitest'
import {
  COMPARE_ANSWER_ONLY,
  COMPARE_INSTRUCTION,
  INTEGRATE_INSTRUCTION,
  buildComparePrompt,
  buildIntegrationRequest,
  cleanCandidate,
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
    expect(user).toContain('Candidate (selected original English):\nOriginal English')
    expect(user).toContain('Candidate (Gemini):\nG text')
    expect(user).toContain('Candidate (Copilot):\nC text')
    expect(system).toMatch(/final English text only/)
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
  it('lists Gemini, Claude, Copilot and Grok symmetrically, all unverified', () => {
    expect(COMPARE_SITES.map((s) => s.id)).toEqual(['gemini', 'claude', 'copilot', 'grok'])
    for (const site of COMPARE_SITES) {
      expect(site.verified).toBe(false)
      expect(site.url).toMatch(/^https:\/\//)
      for (const field of [
        site.inputSelector,
        site.submitSelector,
        site.busySelector,
        site.answerSelector,
      ])
        expect(field.trim()).not.toBe('')
      expect(() => new RegExp(site.loginHint, 'i')).not.toThrow()
      expect(() => new RegExp(site.loggedOutUrl, 'i')).not.toThrow()
      expect(['insertText', 'paste', 'fill']).toContain(site.inputMode)
    }
  })
})
