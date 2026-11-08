import { describe, expect, it } from 'vitest'
import {
  createPassGovernor,
  mergeDirty,
  needsFontsReadyPass,
  sameNumbers,
} from '../src/renderer/pagination-schedule'

describe('mergeDirty', () => {
  it('keeps the smallest pending index', () => {
    expect(mergeDirty(Infinity, 7)).toBe(7)
    expect(mergeDirty(7, 3)).toBe(3)
    expect(mergeDirty(3, 9)).toBe(3)
  })
  it('lets a whole-document trigger absorb everything until consumed', () => {
    expect(mergeDirty(5, null)).toBeNull()
    expect(mergeDirty(null, 2)).toBeNull()
    expect(mergeDirty(Infinity, null)).toBeNull()
  })
})

describe('createPassGovernor', () => {
  it('refuses follow-ups past the window budget and recovers', () => {
    const g = createPassGovernor(3, 1000)
    expect([0, 10, 20].map((t) => g.allowFollowUp(t))).toEqual([true, true, true])
    expect(g.allowFollowUp(30)).toBe(false)
    expect(g.allowFollowUp(1500)).toBe(true)
  })
  it('starts over on a user edit', () => {
    const g = createPassGovernor(1, 1000)
    expect(g.allowFollowUp(0)).toBe(true)
    expect(g.allowFollowUp(1)).toBe(false)
    g.reset()
    expect(g.allowFollowUp(2)).toBe(true)
  })
})

describe('needsFontsReadyPass', () => {
  it('skips the pass when settled fonts were already measured', () => {
    expect(needsFontsReadyPass({ fontsLoading: false, measuredBlocks: 40 })).toBe(false)
  })
  it('keeps it while fonts load or before anything was measured', () => {
    expect(needsFontsReadyPass({ fontsLoading: true, measuredBlocks: 40 })).toBe(true)
    expect(needsFontsReadyPass({ fontsLoading: false, measuredBlocks: 0 })).toBe(true)
  })
})

describe('sameNumbers', () => {
  it('compares flat records including optional keys', () => {
    expect(sameNumbers({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true)
    expect(sameNumbers({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(sameNumbers({ a: 1, b: 2 }, { a: 1, b: 3 })).toBe(false)
  })
})
