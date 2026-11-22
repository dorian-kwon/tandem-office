/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { defaultAiSettings, type AiStreamChunk, type AiStreamRequest } from '@genoffice/ai-provider'
import { defaultProjectFile } from '@genoffice/translate-project'
import { ProjectAssistant } from '../src/renderer/src/translate/ProjectAssistant'
import type { ProjectAssistantActions } from '../src/renderer/src/translate/project-assistant-skill'
import { LocaleProvider } from '../src/renderer/src/locale'
import type { TranslateApi } from '../src/shared/translate-api'
import type { SubscriptionConnection } from '../src/renderer/src/subscription-client'

it.each([true, false])(
  'asks once after the provider gate and sends the wiki choice (%s) to the document and batch',
  async (useWiki) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const listeners = new Set<(chunk: AiStreamChunk) => void>()
    const requests: AiStreamRequest[] = []
    const aiStream = vi.fn(async (request: AiStreamRequest) => {
      requests.push(request)
      const emit = (chunk: Omit<AiStreamChunk, 'requestId'>) =>
        listeners.forEach((f) => f({ requestId: request.requestId, ...chunk }))
      if (requests.length === 1) {
        emit({
          type: 'tool-call',
          toolCall: { id: '1', name: 'open_project_document', input: { file: 'tour.hwp' } },
        })
        emit({
          type: 'tool-call',
          toolCall: {
            id: '2',
            name: 'run_document_ai',
            input: { file: 'tour.hwp', instruction: 'Revise the title' },
          },
        })
        emit({
          type: 'tool-call',
          toolCall: { id: '3', name: 'start_batch_translation', input: { files: ['tour.hwp'] } },
        })
      } else emit({ type: 'delta', text: 'The title was revised and the batch was queued.' })
      emit({ type: 'done' })
    })
    vi.stubGlobal('aiOffice', {
      aiStream,
      aiStreamCancel: vi.fn(),
      onAiStream: (fn: (chunk: AiStreamChunk) => void) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
    })
    const project = defaultProjectFile('Tour', 'ko', 'en')
    project.wikiReferences = ['Tourism.md']
    project.references = ['Tourism.md']
    project.sources.push({ file: 'tour.hwp', kind: 'editable', sha256: 'hash' })
    const runDocumentRequest = vi.fn().mockResolvedValue('Title revised.')
    const batchStart = vi.fn().mockResolvedValue({
      running: true,
      stopping: false,
      items: [{ file: 'tour.hwp', state: 'waiting' }],
    })
    const open = vi.fn().mockResolvedValue('Editor open')
    const actions: ProjectAssistantActions = {
      api: { runDocumentRequest, batchStart } as unknown as TranslateApi,
      dir: '/tours',
      project: () => project,
      open,
      refresh: vi.fn(),
      ocr: vi.fn(),
      confirmRemove: () => false,
      wiki: vi.fn(),
    }
    const connection = {
      statuses: {
        'claude-code': { provider: 'claude-code', state: 'ready', meteredAccepted: false },
        codex: { provider: 'codex', state: 'signed-out', meteredAccepted: false },
      },
    } as SubscriptionConnection
    const notice = vi.fn()
    const settings = defaultAiSettings()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const render = async () =>
      act(async () =>
        root.render(
          createElement(
            LocaleProvider,
            { initial: 'en' },
            createElement(ProjectAssistant, {
              actions,
              connection,
              aiSettings: { ...settings },
              onOpenAiSettings: vi.fn(),
              onNoticeNeeded: notice,
            }),
          ),
        ),
      )
    try {
      await render()
      const area = host.querySelector('textarea')!
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
          area,
          'Open the guide, revise the title, then start the batch.',
        )
        area.dispatchEvent(new Event('input', { bubbles: true }))
      })
      const send = () =>
        act(async () => {
          host.querySelector<HTMLButtonElement>('.ai-send-btn')!.click()
        })
      await send()
      expect(notice).toHaveBeenCalledOnce()
      expect(aiStream).not.toHaveBeenCalled()
      settings.subscriptionNoticeSeen = true
      settings.subscriptionNoticeVersion = 2
      await render()
      await send()
      expect(aiStream).not.toHaveBeenCalled()
      const choice = host.querySelector('[role="group"]')!
      const button = [...choice.querySelectorAll('button')].find(
        (el) => el.textContent === (useWiki ? 'Use wiki notes' : 'Continue without them'),
      )
      await act(async () => button!.click())
      expect(open).toHaveBeenCalledWith('tour.hwp')
      expect(runDocumentRequest).toHaveBeenCalledWith({
        dir: '/tours',
        file: 'tour.hwp',
        prompt: 'Revise the title',
        requestId: expect.any(String),
        useWiki,
      })
      expect(batchStart).toHaveBeenCalledWith({ dir: '/tours', files: ['tour.hwp'], useWiki })
      expect(host.querySelector('[role="log"]')?.textContent).toContain('the batch was queued')
      expect(listeners.size).toBe(0)
    } finally {
      await act(async () => root.unmount())
      host.remove()
      vi.unstubAllGlobals()
    }
  },
)
