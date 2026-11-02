import { describe, expect, it } from 'vitest'

import {
  normalizeCollapsed,
  paneOfSide,
  paneRects,
  visiblePaneRects,
  withPaneHidden,
} from '../src/main/split-layout'
import { TAB_STRIP_HEIGHT } from '../src/shared/tab-drag-geometry'

const content = { x: 0, y: TAB_STRIP_HEIGHT, width: 1200, height: 760 }

describe('paneOfSide', () => {
  it('maps left to the first pane and right to the second', () => {
    expect(paneOfSide('left')).toBe('a')
    expect(paneOfSide('right')).toBe('b')
  })
})

describe('withPaneHidden', () => {
  it('hides a pane and moves focus off it', () => {
    expect(withPaneHidden({ focus: 'a', collapsed: null }, 'a', true)).toEqual({
      focus: 'b',
      collapsed: 'a',
    })
    expect(withPaneHidden({ focus: 'a', collapsed: null }, 'b', true)).toEqual({
      focus: 'a',
      collapsed: 'b',
    })
  })

  it('never hides both panes: hiding one shows the other', () => {
    expect(withPaneHidden({ focus: 'b', collapsed: 'a' }, 'b', true)).toEqual({
      focus: 'a',
      collapsed: 'b',
    })
  })

  it('shows a hidden pane, and leaves another hidden pane alone', () => {
    expect(withPaneHidden({ focus: 'b', collapsed: 'a' }, 'a', false)).toEqual({
      focus: 'b',
      collapsed: null,
    })
    expect(withPaneHidden({ focus: 'a', collapsed: 'b' }, 'a', false)).toEqual({
      focus: 'a',
      collapsed: 'b',
    })
  })
})

describe('normalizeCollapsed', () => {
  it('shows the hidden pane when it takes focus', () => {
    expect(normalizeCollapsed({ focus: 'a', collapsed: 'a' }).collapsed).toBeNull()
    expect(normalizeCollapsed({ focus: 'a', collapsed: 'b' }).collapsed).toBe('b')
  })

  it('treats a missing value as nothing hidden', () => {
    expect(normalizeCollapsed({ focus: 'a' } as never).collapsed).toBeNull()
  })
})

describe('visiblePaneRects', () => {
  it('lays both panes out as paneRects when nothing is hidden', () => {
    const rects = visiblePaneRects(content, { orientation: 'side', ratio: 0.4, collapsed: null })
    expect(rects).toEqual(paneRects(content, 'side', 0.4))
  })

  it('gives the visible pane the whole content area', () => {
    expect(visiblePaneRects(content, { orientation: 'side', ratio: 0.4, collapsed: 'a' })).toEqual({
      a: null,
      b: content,
    })
    expect(visiblePaneRects(content, { orientation: 'stack', ratio: 0.4, collapsed: 'b' })).toEqual(
      { a: content, b: null },
    )
  })
})
