/** @vitest-environment jsdom */
// Translation view AI dock: the source pane never opens its panel from focus
// alone, the output pane keeps its panel open through a focus switch.
import { act, createElement, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  effectiveAiPanelOpen,
  probeTranslationPaneKind,
  useTranslationAiDock,
  type SplitPaneBridge,
  type SplitPaneRole,
} from '../src/split-pane-role'

const KEY = 'aiOfficeSplit'
let host: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
})
afterEach(() => {
  host.remove()
  delete (globalThis as Record<string, unknown>)[KEY]
  vi.unstubAllGlobals()
})

function setup(role: SplitPaneRole, kind: 'source' | 'output', initialOpen: boolean) {
  const handlers = new Set<(r: SplitPaneRole | null) => void>()
  const requestFocus = vi.fn()
  const bridge: SplitPaneBridge = {
    getRole: async () => role,
    onRoleChanged: (h) => {
      handlers.add(h)
      return () => handlers.delete(h)
    },
    requestFocus,
    reportFocus: vi.fn(),
  }
  ;(globalThis as Record<string, unknown>)[KEY] = bridge
  let latest: ReturnType<typeof useTranslationAiDock> | null = null
  let local = initialOpen
  function Probe() {
    const [open, setOpen] = useState(initialOpen)
    local = open
    latest = useTranslationAiDock(open, setOpen, {
      isSource: async () => kind === 'source',
      isOutput: async () => kind === 'output',
    })
    return null
  }
  const root = createRoot(host)
  act(() => root.render(createElement(Probe)))
  return {
    get dock() {
      return latest!
    },
    get local() {
      return local
    },
    push: (r: SplitPaneRole | null) => act(() => handlers.forEach((h) => h(r))),
    requestFocus,
    settle: () => act(async () => {}),
    unmount: () => act(() => root.unmount()),
  }
}

describe('effectiveAiPanelOpen with a pane kind', () => {
  it('keeps the output panel through the secondary role', () => {
    expect(effectiveAiPanelOpen(true, 'secondary', 'output')).toBe(true)
    expect(effectiveAiPanelOpen(false, 'secondary', 'output')).toBe(false)
  })
  it('still forces ordinary secondary panes to the rail', () => {
    expect(effectiveAiPanelOpen(true, 'secondary', null)).toBe(false)
    expect(effectiveAiPanelOpen(true, 'secondary', 'source')).toBe(false)
  })
})

describe('probeTranslationPaneKind', () => {
  it('resolves source, output, none, and treats a failing probe as no', async () => {
    expect(await probeTranslationPaneKind({ isSource: async () => true })).toBe('source')
    expect(await probeTranslationPaneKind({ isOutput: async () => true })).toBe('output')
    expect(await probeTranslationPaneKind({})).toBe(null)
    expect(
      await probeTranslationPaneKind({
        isSource: async () => {
          throw new Error('x')
        },
      }),
    ).toBe(null)
  })
})

describe('source pane', () => {
  it('starts closed even when its stored state says open, and stays closed on focus', async () => {
    const s = setup('secondary', 'source', true)
    await s.settle()
    expect(s.local).toBe(false)
    s.push('focus')
    expect(s.dock.open).toBe(false)
    s.push('secondary')
    s.push('focus')
    expect(s.dock.open).toBe(false)
    s.unmount()
  })
  it('opens on a press while it has focus', async () => {
    const s = setup('focus', 'source', true)
    await s.settle()
    expect(s.dock.open).toBe(false)
    act(() => s.dock.onExpand())
    expect(s.dock.open).toBe(true)
    // the opened panel survives a role round trip
    s.push('secondary')
    s.push('focus')
    expect(s.dock.open).toBe(true)
    s.unmount()
  })
  it('opens on a rail press while unfocused: asks for focus, then shows', async () => {
    const s = setup('secondary', 'source', true)
    await s.settle()
    act(() => s.dock.onExpand())
    expect(s.requestFocus).toHaveBeenCalledOnce()
    s.push('focus')
    expect(s.dock.open).toBe(true)
    s.unmount()
  })
})

describe('output pane', () => {
  it('is open by default and stays open when the source takes focus and back', async () => {
    const s = setup('focus', 'output', true)
    await s.settle()
    expect(s.dock.open).toBe(true)
    s.push('secondary')
    expect(s.dock.open).toBe(true)
    s.push('focus')
    expect(s.dock.open).toBe(true)
    s.unmount()
  })
  it('respects an explicit close', async () => {
    const s = setup('focus', 'output', true)
    await s.settle()
    act(() => s.dock.onExpand())
    expect(s.dock.open).toBe(false)
    s.push('secondary')
    expect(s.dock.open).toBe(false)
    s.unmount()
  })
})
