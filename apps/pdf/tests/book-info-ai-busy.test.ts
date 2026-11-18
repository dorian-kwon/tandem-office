import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { BookInfoAiFill } from '../src/renderer/convert/BookInfoAiFill'
import type { TFunc } from '../src/renderer/i18n/locale'

const fake = vi.hoisted(() => ({ stream: vi.fn() }))
vi.mock('@genoffice/agent-core', async (load) => ({
  ...(await load<typeof import('@genoffice/agent-core')>()),
  streamText: fake.stream,
}))
vi.mock('@genoffice/ui', async (load) => ({
  ...(await load<typeof import('@genoffice/ui')>()),
  useAiSendGate: () => ({ admit: () => true, connectChoice: null, noticeDue: false }),
}))
vi.mock('../src/renderer/ai/useSubscriptionConnection', () => ({
  useSubscriptionConnection: () => ({ statuses: {} }),
}))

it('holds PDF metadata work from text collection through stream settlement, even after closing the dialog', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let finish!: (value: unknown) => void
  fake.stream.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    }),
  )
  window.pdfApi = { getAiSettings: async () => ({}), onAiSettingsChanged: () => () => {} } as never
  const host = document.createElement('div')
  const root = createRoot(host)
  let mounted = true
  try {
    await act(async () =>
      root.render(
        createElement(BookInfoAiFill, {
          press: 1,
          lang: 'en',
          t: ((key: string) => key) as TFunc,
          collectText: async () => 'book opening',
          onSuggest: () => {},
          onStateChange: () => {},
        }),
      ),
    )
    expect(fake.stream).toHaveBeenCalledTimes(1)
    expect(window.__tandemEditorAiBusy).toBe(true)
    await act(async () => root.unmount())
    mounted = false
    expect(window.__tandemEditorAiBusy).toBe(true)
    await act(async () => finish({ status: 'empty' }))
    expect(window.__tandemEditorAiBusy).toBe(false)
  } finally {
    if (mounted) await act(async () => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})
