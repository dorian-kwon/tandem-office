import { describe, expect, it } from 'vitest'
import { normalizeProjectName, PROJECT_NAME_MAX } from '../src/shared/project-name'

describe('normalizeProjectName', () => {
  it('trims and keeps any script', () => {
    expect(normalizeProjectName('  계약서 2024  ')).toBe('계약서 2024')
  })
  it('rejects empty, blank, too long, control characters and non-strings', () => {
    expect(normalizeProjectName('')).toBeNull()
    expect(normalizeProjectName('   ')).toBeNull()
    expect(normalizeProjectName('x'.repeat(PROJECT_NAME_MAX + 1))).toBeNull()
    expect(normalizeProjectName('a\nb')).toBeNull()
    expect(normalizeProjectName('a\u0000b')).toBeNull()
    expect(normalizeProjectName(7)).toBeNull()
  })
  it('accepts exactly the maximum length', () => {
    expect(normalizeProjectName('x'.repeat(PROJECT_NAME_MAX))).toHaveLength(PROJECT_NAME_MAX)
  })
})
