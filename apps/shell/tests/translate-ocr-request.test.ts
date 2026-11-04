/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LocaleProvider } from '../src/renderer/src/locale'
import type { SubscriptionConnection } from '../src/renderer/src/subscription-client'
import { TranslationPanel } from '../src/renderer/src/translate/TranslationPanel'

/**
 * The sheets AI's picture OCR asks the home screen for the OCR selection popup: the panel
 * opens that project and lists its source's items. A fake bridge, no AI.
 */
const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
env.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let api: Record<string, ReturnType<typeof vi.fn>>

const source = { file: 'owner.xlsx', sha256: 'x', kind: 'editable' }
const project = {
  version: 1,
  name: 'p',
  sources: [source],
  references: [],
  glossaryFiles: [],
  projectPrompt: '',
  sourceLang: 'auto',
  targetLang: 'en',
  ocr: { kind: 'ai', provider: 'claude' },
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  api = {
    list: vi.fn().mockResolvedValue([]),
    recent: vi.fn().mockResolvedValue([]),
    getProject: vi.fn().mockResolvedValue(project),
    referenceStatus: vi.fn().mockResolvedValue({}),
    pictureInfo: vi.fn().mockResolvedValue([]),
    getSystemPrompt: vi.fn().mockResolvedValue(''),
    ocrPrepare: vi.fn().mockReturnValue(new Promise(() => undefined)),
    ocrRelease: vi.fn().mockResolvedValue(undefined),
  }
  ;(window as unknown as { translateApi: unknown }).translateApi = api
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  delete (window as unknown as { translateApi?: unknown }).translateApi
})

const connection = { statuses: {}, busy: false, failed: {} } as unknown as SubscriptionConnection

async function render(ocrRequest: { dir: string; file: string; seq: number } | null) {
  await act(async () => {
    root.render(
      createElement(
        LocaleProvider,
        { initial: 'en' },
        createElement(TranslationPanel, { connection, ocrRequest }),
      ),
    )
  })
}

it('opens the project and the OCR selection for a request, once per request', async () => {
  await render(null)
  expect(api.ocrPrepare).not.toHaveBeenCalled()
  await render({ dir: '/work/p1', file: 'owner.xlsx', seq: 1 })
  expect(api.getProject).toHaveBeenCalledWith('/work/p1')
  expect(api.ocrPrepare).toHaveBeenCalledWith({ dir: '/work/p1', files: ['owner.xlsx'] })
  await render({ dir: '/work/p1', file: 'owner.xlsx', seq: 1 })
  expect(api.ocrPrepare).toHaveBeenCalledTimes(1)
})
