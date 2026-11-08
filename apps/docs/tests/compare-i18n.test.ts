import { describe, expect, it } from 'vitest'
import { zh } from '../src/renderer/i18n/ai/zh'
import { ko } from '../src/renderer/i18n/ai/ko'

const shards = import.meta.glob('../src/renderer/i18n/ai/*.ts', { eager: true }) as Record<
  string,
  Record<string, Record<string, string>>
>

const KEYS = Object.keys(zh).filter((k) => k.startsWith('cmp'))

describe('AI compare strings', () => {
  it('exist, non-empty, in all 21 languages', () => {
    const langs = Object.keys(shards).map((p) => p.split('/').pop()!.replace('.ts', ''))
    expect(langs).toHaveLength(21)
    expect(KEYS.length).toBeGreaterThanOrEqual(40)
    for (const path of Object.keys(shards)) {
      const dict = Object.values(shards[path]!)[0]!
      for (const key of KEYS) {
        expect(typeof dict[key], `${path} ${key}`).toBe('string')
        expect(dict[key]!.trim(), `${path} ${key}`).not.toBe('')
      }
      expect(dict.cmpManual, path).toContain('{name}')
      expect(dict.cmpCut, path).toContain('{max}')
      expect(dict.cmpLeaves, path).toContain('{sites}')
      expect(dict.cmpEgoSteps, path).toContain('{sites}')
    }
  })

  it('the Korean install question and buttons are the owner-specified wording', () => {
    expect(ko.cmpEgoMissing).toBe('ego 브라우저가 설치되어 있지 않습니다. 설치할까요?')
    expect(ko.cmpInstall).toBe('설치')
    expect(ko.cmpLater).toBe('나중에')
    expect(ko.cmpRecheck).toBe('다시 확인')
    expect(ko.cmpBtn).toBe('AI 비교')
    expect(ko.cmpStSkipped).toBe('건너뜀 (로그인 안 됨)')
    expect(ko.cmpAddOriginal).toBe('원문 추가')
    expect(ko.cmpRetranslate).toBe('재번역 포함')
    expect(ko.cmpKindPolished).toBe('다듬기')
    expect(ko.cmpKindRetranslated).toBe('재번역')
  })

  it('the other languages are real translations, not copies of the English text', async () => {
    const en = Object.values(shards['../src/renderer/i18n/ai/en.ts']!)[0]!
    for (const path of Object.keys(shards)) {
      if (path.endsWith('/en.ts')) continue
      const dict = Object.values(shards[path]!)[0]!
      expect(dict.cmpLeaves, path).not.toBe(en.cmpLeaves)
      expect(dict.cmpEgoSteps, path).not.toBe(en.cmpEgoSteps)
    }
  })
})
