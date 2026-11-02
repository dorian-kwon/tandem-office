import { describe, expect, it } from 'vitest'
import {
  ProjectFileError,
  defaultProjectFile,
  parseProjectFile,
  serializeProjectFile,
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
})
