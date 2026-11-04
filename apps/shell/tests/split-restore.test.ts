import { describe, expect, it, vi } from 'vitest'

import { restoreRememberedSplit, type SplitRestoreDeps } from '../src/main/split-restore'
import type { SplitMemory } from '../src/main/split-memory'

function deps(onDisk: string[]) {
  const opened: { path: string; recordRecent: boolean }[] = []
  const d = {
    opened,
    fileOnDisk: (path?: string) => (path !== undefined && onDisk.includes(path) ? path : undefined),
    samePath: (a: string, b: string) => a === b,
    openTab: vi.fn((path: string, options: { recordRecent: boolean }) => {
      opened.push({ path, recordRecent: options.recordRecent })
      return `t:${path}`
    }),
    openHome: vi.fn(),
    openDuplicatePaneTab: vi.fn((id: string) => `${id}#2`),
    setTabReadOnly: vi.fn(() => true),
    groupTabs: vi.fn(() => true),
    beginSplit: vi.fn(),
  } satisfies SplitRestoreDeps & { opened: unknown[] }
  return d
}

const translation: SplitMemory = {
  version: 1,
  a: '/p/source/a.docx',
  b: '/p/output/a.docx',
  orientation: 'side',
  ratio: 0.5,
  focus: 'b',
  collapsed: 'a',
  readOnly: 'a',
}

describe('restoreRememberedSplit', () => {
  it('reopens a translation split with the source read-only and out of Recent', () => {
    const d = deps([translation.a, translation.b!])
    restoreRememberedSplit(translation, d)
    expect(d.opened).toEqual([
      { path: '/p/source/a.docx', recordRecent: false },
      { path: '/p/output/a.docx', recordRecent: true },
    ])
    expect(d.setTabReadOnly).toHaveBeenCalledWith('t:/p/source/a.docx')
    expect(d.beginSplit).toHaveBeenCalledWith(
      't:/p/source/a.docx',
      't:/p/output/a.docx',
      'side',
      0.5,
      'b',
      'a',
    )
  })

  it('groups the restored translation pair so it closes together', () => {
    const d = deps([translation.a, translation.b!])
    restoreRememberedSplit(translation, d)
    expect(d.groupTabs).toHaveBeenCalledWith('t:/p/source/a.docx', 't:/p/output/a.docx')
  })

  it('drops the source when its output is gone (no orphan source tab)', () => {
    const d = deps([translation.a])
    restoreRememberedSplit(translation, d)
    expect(d.opened).toEqual([])
    expect(d.openHome).toHaveBeenCalled()
    expect(d.beginSplit).not.toHaveBeenCalled()
  })

  it('opens the output alone and plain when its source is gone', () => {
    const d = deps([translation.b!])
    restoreRememberedSplit(translation, d)
    expect(d.opened).toEqual([{ path: '/p/output/a.docx', recordRecent: true }])
    expect(d.setTabReadOnly).not.toHaveBeenCalled()
    expect(d.groupTabs).not.toHaveBeenCalled()
  })

  it('makes the source read-only before the output copy opens', () => {
    const order: string[] = []
    const d = deps([translation.a, translation.b!])
    d.openTab.mockImplementation((path: string) => {
      order.push(`open ${path}`)
      return `t:${path}`
    })
    d.setTabReadOnly.mockImplementation((id: string) => {
      order.push(`read-only ${id}`)
      return true
    })
    restoreRememberedSplit(translation, d)
    expect(order).toEqual([
      'open /p/source/a.docx',
      'read-only t:/p/source/a.docx',
      'open /p/output/a.docx',
    ])
  })

  it('shows both panes when the source could not be made read-only', () => {
    const d = deps([translation.a, translation.b!])
    d.setTabReadOnly.mockImplementation(() => false)
    restoreRememberedSplit(translation, d)
    expect(d.beginSplit.mock.calls[0]?.[5]).toBeNull()
  })

  it('keeps an ordinary split as before (Recent, no read-only, nothing hidden)', () => {
    const memory: SplitMemory = { version: 1, a: '/x.docx', b: '/y.docx', focus: 'a' }
    const d = deps(['/x.docx', '/y.docx'])
    restoreRememberedSplit(memory, d)
    expect(d.opened.every((o) => o.recordRecent)).toBe(true)
    expect(d.setTabReadOnly).not.toHaveBeenCalled()
    expect(d.beginSplit).toHaveBeenCalledWith('t:/x.docx', 't:/y.docx', 'side', 0.5, 'a', null)
  })

  it('opens home when nothing remembered is on disk', () => {
    const d = deps([])
    restoreRememberedSplit(translation, d)
    expect(d.openHome).toHaveBeenCalled()
    restoreRememberedSplit(null, d)
    expect(d.openHome).toHaveBeenCalledTimes(2)
  })

  it('duplicates one tab when both panes held the same file', () => {
    const memory: SplitMemory = { version: 1, a: '/x.docx', b: '/x.docx' }
    const d = deps(['/x.docx'])
    restoreRememberedSplit(memory, d)
    expect(d.openDuplicatePaneTab).toHaveBeenCalledWith('t:/x.docx')
    expect(d.beginSplit).toHaveBeenCalledWith('t:/x.docx', 't:/x.docx#2', 'side', 0.5, 'b', null)
  })
})
