import { describe, expect, it } from 'vitest'
import {
  isTranslationOutputTab,
  isTranslationSourceTab,
  TRANSLATION_OUTPUT_CHANNEL,
  TRANSLATION_SOURCE_CHANNEL,
} from '../src/main/translation-output'

const split = { aTabId: 'src', bTabId: 'out' }
const readOnly = (id: string) => id === 'src'

describe('isTranslationOutputTab', () => {
  it('is the editable pane beside a read-only source pane', () => {
    expect(isTranslationOutputTab('out', split, readOnly)).toBe(true)
    expect(isTranslationOutputTab('out', { aTabId: 'out', bTabId: 'src' }, readOnly)).toBe(true)
  })
  it('is not the source pane itself', () => {
    expect(isTranslationOutputTab('src', split, readOnly)).toBe(false)
  })
  it('is not any pane of an ordinary split, or a document outside the split', () => {
    expect(isTranslationOutputTab('out', split, () => false)).toBe(false)
    expect(isTranslationOutputTab('other', split, readOnly)).toBe(false)
    expect(isTranslationOutputTab('out', null, readOnly)).toBe(false)
    expect(isTranslationOutputTab(undefined, split, readOnly)).toBe(false)
  })
  it('uses a channel the editors can name', () => {
    expect(TRANSLATION_OUTPUT_CHANNEL).toBe('app:is-translation-output')
  })
})

describe('isTranslationSourceTab', () => {
  it('is the read-only pane of the split, on either side', () => {
    expect(isTranslationSourceTab('src', split, readOnly)).toBe(true)
    expect(isTranslationSourceTab('src', { aTabId: 'out', bTabId: 'src' }, readOnly)).toBe(true)
  })
  it('is not the output, an ordinary split, or a tab outside the split', () => {
    expect(isTranslationSourceTab('out', split, readOnly)).toBe(false)
    expect(isTranslationSourceTab('src', split, () => false)).toBe(false)
    expect(isTranslationSourceTab('src', null, readOnly)).toBe(false)
    expect(isTranslationSourceTab('other', split, () => true)).toBe(false)
  })
  it('uses a channel the editors can name', () => {
    expect(TRANSLATION_SOURCE_CHANNEL).toBe('app:is-translation-source')
  })
})
