// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { TabBar } from '../src/renderer/src/TabBar'
import { LocaleProvider } from '../src/renderer/src/locale'
import type { DocumentTabKind, TabSummary } from '../src/shared/tabs-api'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('runs OCR by tab ID for each focused editor, including read-only files, once a path is available', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  HTMLElement.prototype.scrollIntoView ??= vi.fn()
  const makeTab = (kind: TabSummary['kind'], id: string, active = true): TabSummary => ({
    kind,
    id,
    title: id,
    active,
    closable: kind !== 'home',
  })
  const home = makeTab('home', 'home')
  let changed!: (next: TabSummary[]) => void
  let finish!: () => void
  const ocrDocument = vi.fn(
    () =>
      new Promise<void>((r) => {
        finish = r
      }),
  )
  vi.stubGlobal('aiOfficeTabs', {
    list: async () => [home],
    onChanged: (listener: typeof changed) => {
      changed = listener
      return () => {}
    },
    onSplitHint: () => () => {},
    ocrDocument,
  })
  const host = document.createElement('div')
  const root = createRoot(host)
  const button = () => host.querySelector<HTMLButtonElement>('[data-testid="document-ocr"]')
  try {
    await act(async () =>
      root.render(
        createElement(LocaleProvider, {
          initial: 'ko',
          children: createElement(TabBar, { split: null }),
        }),
      ),
    )
    expect(button()).toBeNull()
    await act(async () =>
      changed([home, makeTab('help', 'manual')].map((t) => ({ ...t, active: t.kind === 'help' }))),
    )
    expect(button()).toBeNull()
    const kinds: DocumentTabKind[] = [
      'docs',
      'sheets',
      'slides',
      'hwp',
      'pdf',
      'markdown',
      'html',
      'epub',
      'mindmap',
    ]
    for (const kind of kinds) {
      const current = { ...makeTab(kind, 'current-' + kind), readOnly: true as const }
      await act(async () => changed([makeTab('docs', 'background', false), current]))
      expect(button()?.disabled).toBe(true)
      expect(button()?.title).toContain('문서를 저장')
      await act(async () =>
        changed([
          makeTab('docs', 'background', false),
          { ...current, filePath: '/work/' + current.id },
        ]),
      )
      expect(button()?.getAttribute('aria-label')).toBe('이 문서에서 OCR 하기')
      await act(async () => button()!.click())
      expect(ocrDocument).toHaveBeenLastCalledWith(current.id)
      expect(button()?.disabled).toBe(true)
      await act(async () => finish())
      expect(button()?.disabled).toBe(false)
    }
    expect(ocrDocument).toHaveBeenCalledTimes(kinds.length)
  } finally {
    await act(async () => root.unmount())
  }
})
