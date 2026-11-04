import { describe, expect, it } from 'vitest'
import { filterProjects, paginate } from '../src/renderer/src/translate/project-table'
import type { TranslateProjectListEntry } from '../src/shared/translate-api'

const entry = (name: string, dir = `/p/${name}`): TranslateProjectListEntry =>
  ({ name, dir, status: 'ok', sourceLang: 'ko', targetLang: 'en', sourceCount: 1, referenceCount: 0, lastOpened: 0 }) as TranslateProjectListEntry

describe('project list search and paging', () => {
  const list = [entry('Webtoon 22'), entry('Annual Report'), entry('웹툰 23', '/x/y')]
  const pair = () => 'Korean English'
  it('matches every word, case-insensitively, on name, folder and pair', () => {
    expect(filterProjects(list, 'webtoon', pair).map((e) => e.name)).toEqual(['Webtoon 22'])
    expect(filterProjects(list, 'report annual', pair)).toHaveLength(1)
    expect(filterProjects(list, '/x/y', pair)).toHaveLength(1)
    expect(filterProjects(list, 'korean', pair)).toHaveLength(3)
    expect(filterProjects(list, '  ', pair)).toHaveLength(3)
    expect(filterProjects(list, 'zzz', pair)).toHaveLength(0)
  })
  it('slices pages and clamps a page past the end', () => {
    const many = Array.from({ length: 23 }, (_, i) => i)
    expect(paginate(many, 0, 10)).toMatchObject({ from: 1, to: 10, pageCount: 3 })
    expect(paginate(many, 2, 10)).toMatchObject({ from: 21, to: 23, items: [20, 21, 22] })
    expect(paginate(many, 9, 10).page).toBe(2)
    expect(paginate([], 0, 10)).toMatchObject({ from: 0, to: 0, pageCount: 1, total: 0 })
  })
})
