import { describe, expect, it } from 'vitest'
import { middleEllipsis, sortProjects } from '../src/renderer/src/translate/project-table'
import type { TranslateProjectListEntry } from '../src/shared/translate-api'

function e(name: string, lastOpened: number): TranslateProjectListEntry {
  return {
    dir: `/p/${name}`,
    name,
    status: 'ok',
    sourceLang: 'en',
    targetLang: 'ko',
    lastOpened,
    sourceCount: 0,
    referenceCount: 0,
  }
}

const names = (list: TranslateProjectListEntry[]) => list.map((x) => x.name)

describe('sortProjects', () => {
  const list = [e('beta', 5), e('Alpha', 9), e('gamma', 1)]
  it('sorts by last opened in either direction', () => {
    expect(names(sortProjects(list, { key: 'lastOpened', dir: 'desc' }, 'en'))).toEqual([
      'Alpha',
      'beta',
      'gamma',
    ])
    expect(names(sortProjects(list, { key: 'lastOpened', dir: 'asc' }, 'en'))).toEqual([
      'gamma',
      'beta',
      'Alpha',
    ])
  })
  it('sorts by name ignoring case, in either direction', () => {
    expect(names(sortProjects(list, { key: 'name', dir: 'asc' }, 'en'))).toEqual([
      'Alpha',
      'beta',
      'gamma',
    ])
    expect(names(sortProjects(list, { key: 'name', dir: 'desc' }, 'en'))).toEqual([
      'gamma',
      'beta',
      'Alpha',
    ])
  })
  it('does not change the input and keeps ties in order', () => {
    const tied = [e('a', 1), e('b', 1)]
    expect(names(sortProjects(tied, { key: 'lastOpened', dir: 'desc' }, 'en'))).toEqual(['a', 'b'])
    expect(names(list)).toEqual(['beta', 'Alpha', 'gamma'])
  })
})

describe('middleEllipsis', () => {
  it('keeps short text', () => {
    expect(middleEllipsis('/a/b', 20)).toBe('/a/b')
  })
  it('shortens in the middle to the given length, keeping both ends', () => {
    const out = middleEllipsis('/Users/someone/Documents/translations/project-one', 24)
    expect(out).toHaveLength(24)
    expect(out.startsWith('/Users/')).toBe(true)
    expect(out.endsWith('project-one')).toBe(true)
    expect(out).toContain('…')
  })
})
