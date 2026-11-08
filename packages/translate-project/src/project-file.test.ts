import { describe, expect, it } from 'vitest'
import {
  ProjectFileError,
  defaultProjectFile,
  parseProjectFile,
  serializeProjectFile,
  TRANSLATION_CHOICE_MAX_CHARS,
  withChoice,
} from './project-file'

describe('project file', () => {
  it('roundtrips a default project file', () => {
    const p = defaultProjectFile('Contract', 'ko', 'en')
    expect(parseProjectFile(serializeProjectFile(p))).toEqual(p)
  })

  it('default OCR is ai with claude', () => {
    expect(defaultProjectFile('x', 'ko', 'en').ocr).toEqual({ kind: 'ai', provider: 'claude' })
  })

  it('rejects version 2 with ProjectFileError', () => {
    const p = { ...defaultProjectFile('x', 'ko', 'en'), version: 2 }
    expect(() => parseProjectFile(JSON.stringify(p))).toThrow(ProjectFileError)
  })

  it('rejects missing name', () => {
    const { name: _name, ...rest } = defaultProjectFile('x', 'ko', 'en')
    expect(() => parseProjectFile(JSON.stringify(rest))).toThrow(ProjectFileError)
  })

  it('rejects invalid JSON and bad nested values', () => {
    expect(() => parseProjectFile('{')).toThrow(ProjectFileError)
    const p = { ...defaultProjectFile('x', 'ko', 'en'), ocr: { kind: 'ai', provider: 'bard' } }
    expect(() => parseProjectFile(JSON.stringify(p))).toThrow(ProjectFileError)
    const q = {
      ...defaultProjectFile('x', 'ko', 'en'),
      sources: [{ file: 'a', sha256: 'b', kind: 'zip' }],
    }
    expect(() => parseProjectFile(JSON.stringify(q))).toThrow(ProjectFileError)
  })

  it('projectPrompt never contains the system prompt field', () => {
    const p = defaultProjectFile('x', 'ko', 'en')
    expect(p).not.toHaveProperty('systemPrompt')
    expect(parseProjectFile(serializeProjectFile(p))).not.toHaveProperty('systemPrompt')
    const withExtra = JSON.stringify({ ...p, systemPrompt: 'leak' })
    expect(parseProjectFile(withExtra)).not.toHaveProperty('systemPrompt')
  })

  it('rejects file names that are empty, dotted or contain a separator', () => {
    const base = defaultProjectFile('x', 'ko', 'en')
    const bad = ['', '.', '..', 'a/b', 'a\\b', '../x']
    for (const name of bad) {
      const entry = { file: name, sha256: 'h', kind: 'pdf' }
      for (const p of [
        { ...base, sources: [entry] },
        { ...base, references: [name] },
        { ...base, glossaryFiles: [name] },
      ]) {
        expect(() => parseProjectFile(JSON.stringify(p))).toThrow(ProjectFileError)
      }
    }
    const ok = { ...base, references: ['a.txt'], glossaryFiles: ['g.csv'] }
    expect(parseProjectFile(JSON.stringify(ok)).references).toEqual(['a.txt'])
  })

  describe('writing style', () => {
    it('starts a new project with the Oxford comma and punctuation inside the quotes', () => {
      expect(defaultProjectFile('x', 'ko', 'en').writingStyle).toEqual({
        serialComma: 'with',
        quotePunctuation: 'inside',
        custom: '',
      })
    })

    it('reads an old project file without writingStyle as the default', () => {
      const { writingStyle: _w, ...old } = defaultProjectFile('x', 'ko', 'en')
      expect(parseProjectFile(JSON.stringify(old)).writingStyle).toEqual({
        serialComma: 'default',
        quotePunctuation: 'default',
        custom: '',
      })
    })

    it('roundtrips chosen values', () => {
      const p = {
        ...defaultProjectFile('x', 'ko', 'en'),
        writingStyle: { serialComma: 'with', quotePunctuation: 'inside', custom: 'Use "colour".' },
      }
      expect(parseProjectFile(serializeProjectFile(p as never))).toEqual(p)
    })

    it('rejects unknown values and wrong types', () => {
      const bad = (ws: unknown) =>
        JSON.stringify({ ...defaultProjectFile('x', 'ko', 'en'), writingStyle: ws })
      expect(() => parseProjectFile(bad({ serialComma: 'maybe' }))).toThrow(ProjectFileError)
      expect(() => parseProjectFile(bad({ quotePunctuation: 'around' }))).toThrow(ProjectFileError)
      expect(() => parseProjectFile(bad({ custom: 3 }))).toThrow(ProjectFileError)
      expect(() => parseProjectFile(bad('x'))).toThrow(ProjectFileError)
    })

    it('fills missing fields of a partial writingStyle with defaults', () => {
      const raw = JSON.stringify({
        ...defaultProjectFile('x', 'ko', 'en'),
        writingStyle: { serialComma: 'without' },
      })
      expect(parseProjectFile(raw).writingStyle).toEqual({
        serialComma: 'without',
        quotePunctuation: 'default',
        custom: '',
      })
    })
  })

  describe('choices (answers kept for the rest of the project)', () => {
    it('is absent on a new project and on an old file', () => {
      expect(defaultProjectFile('x', 'ko', 'en').choices).toBeUndefined()
      const raw = JSON.stringify(defaultProjectFile('x', 'ko', 'en'))
      expect(raw).not.toContain('choices')
      expect(parseProjectFile(raw).choices).toBeUndefined()
    })

    it('roundtrips stored answers', () => {
      const p = {
        ...defaultProjectFile('x', 'ko', 'en'),
        choices: { outputMode: 'Keep the original', bilingual: 'Two columns' },
      }
      expect(parseProjectFile(serializeProjectFile(p))).toEqual(p)
    })

    it('drops unknown keys, blank and non-string values, and trims', () => {
      const raw = JSON.stringify({
        ...defaultProjectFile('x', 'ko', 'en'),
        choices: { outputMode: '  Overwrite  ', bilingual: '', ocrPlacement: 4, other: 'x' },
      })
      expect(parseProjectFile(raw).choices).toEqual({ outputMode: 'Overwrite' })
    })

    it('reads an empty or malformed value as none instead of failing the project', () => {
      for (const choices of [{}, [], 'x', null, 7]) {
        const raw = JSON.stringify({ ...defaultProjectFile('x', 'ko', 'en'), choices })
        expect(parseProjectFile(raw).choices).toBeUndefined()
      }
    })

    it('cuts an overlong answer', () => {
      const raw = JSON.stringify({
        ...defaultProjectFile('x', 'ko', 'en'),
        choices: { bilingual: 'a'.repeat(TRANSLATION_CHOICE_MAX_CHARS + 50) },
      })
      expect(parseProjectFile(raw).choices?.bilingual).toHaveLength(TRANSLATION_CHOICE_MAX_CHARS)
    })

    it('withChoice sets and clears one answer and leaves the rest', () => {
      const p = defaultProjectFile('x', 'ko', 'en')
      const a = withChoice(p, 'outputMode', 'Overwrite')
      expect(a.choices).toEqual({ outputMode: 'Overwrite' })
      const b = withChoice(a, 'bilingual', 'Two columns')
      expect(b.choices).toEqual({ outputMode: 'Overwrite', bilingual: 'Two columns' })
      const c = withChoice(b, 'outputMode', null)
      expect(c.choices).toEqual({ bilingual: 'Two columns' })
      expect(withChoice(c, 'bilingual', null).choices).toBeUndefined()
      expect(p.choices).toBeUndefined()
    })
  })
})
