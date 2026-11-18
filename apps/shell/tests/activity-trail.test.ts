import { describe, expect, it } from 'vitest'
import { createActivityTrail, tabChangeActions, tabCounts } from '../src/main/activity-trail'

/**
 * The trail is what tells a crash line what the person was doing: a short, in-memory list
 * of fixed action words with the seconds since the app started. Nothing free-form is kept.
 */

function clock(start = 1_000_000): { now: () => number; advance: (seconds: number) => void } {
  let at = start
  return { now: () => at, advance: (seconds) => void (at += seconds * 1000) }
}

describe('createActivityTrail', () => {
  it('records each action with the seconds since the trail began', () => {
    const c = clock()
    const trail = createActivityTrail({ now: c.now })
    trail.note('app-start')
    c.advance(42)
    trail.note('tab-open:docs')
    c.advance(3.9)
    trail.note('ai-start')
    expect(trail.recent()).toEqual([
      { t: 0, a: 'app-start' },
      { t: 42, a: 'tab-open:docs' },
      { t: 45, a: 'ai-start' },
    ])
  })

  it('reports the seconds the app has run', () => {
    const c = clock()
    const trail = createActivityTrail({ now: c.now })
    expect(trail.uptimeS()).toBe(0)
    c.advance(125.7)
    expect(trail.uptimeS()).toBe(125)
  })

  it('ignores anything that is not an action word', () => {
    const trail = createActivityTrail({ now: clock().now })
    trail.note('opened C:\\Users\\someone\\salary.xlsx')
    trail.note('Save File')
    trail.note('/home/someone/plan.docx')
    trail.note('')
    trail.note('save')
    expect(trail.recent()).toEqual([{ t: 0, a: 'save' }])
  })

  it('keeps only the newest entries once it is full', () => {
    const c = clock()
    const trail = createActivityTrail({ max: 3, now: c.now })
    for (const a of ['a1', 'a2', 'a3', 'a4', 'a5']) {
      trail.note(a)
      c.advance(1)
    }
    expect(trail.recent().map((i) => i.a)).toEqual(['a3', 'a4', 'a5'])
  })

  it('gives the last `count` entries, oldest first', () => {
    const trail = createActivityTrail({ now: clock().now })
    for (const a of ['a1', 'a2', 'a3', 'a4']) trail.note(a)
    expect(trail.recent(2).map((i) => i.a)).toEqual(['a3', 'a4'])
  })

  it('hands out copies, so a caller cannot change the record', () => {
    const trail = createActivityTrail({ now: clock().now })
    trail.note('save')
    const first = trail.recent()
    first[0]!.a = 'changed'
    first.push({ t: 9, a: 'extra' })
    expect(trail.recent()).toEqual([{ t: 0, a: 'save' }])
  })
})

describe('tabChangeActions', () => {
  const tab = (id: string, kind: string): { id: string; kind: string } => ({ id, kind })

  it('names the tabs that appeared and the ones that went, by editor kind only', () => {
    const first = tabChangeActions(new Map(), [tab('h', 'home'), tab('a', 'docs')])
    expect(first.actions).toEqual(['tab-open:home', 'tab-open:docs'])
    const second = tabChangeActions(first.next, [tab('h', 'home'), tab('b', 'sheets')])
    expect(second.actions).toEqual(['tab-open:sheets', 'tab-close:docs'])
  })

  it('says nothing when the same tabs are still open, or one only changed its title', () => {
    const first = tabChangeActions(new Map(), [tab('a', 'docs')])
    expect(tabChangeActions(first.next, [tab('a', 'docs')]).actions).toEqual([])
  })

  it('drops a kind that is not a plain action word', () => {
    expect(tabChangeActions(new Map(), [tab('a', 'My Kind!')]).actions).toEqual([])
  })
})

describe('tabCounts', () => {
  it('counts open tabs per editor kind, leaving Home out', () => {
    expect(
      tabCounts([
        { id: 'h', kind: 'home' },
        { id: 'a', kind: 'docs' },
        { id: 'b', kind: 'docs' },
        { id: 'c', kind: 'sheets' },
      ]),
    ).toEqual({ docs: 2, sheets: 1 })
    expect(tabCounts([{ id: 'h', kind: 'home' }])).toEqual({})
  })
})
