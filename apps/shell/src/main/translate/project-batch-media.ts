import {
  isSubscriptionProvider,
  streamForProvider,
  type AiSettings,
  type AiSubscriptionStatuses,
} from '@genoffice/ai-provider'
import { aiRunRefusal } from '@genoffice/electron-utils/ai-run-guard'
import type { ProjectFile, SourceEntry } from '@genoffice/translate-project'
import { aiSendGate } from '../../../../../packages/ui/src/ai-send-gate'
import type { TranslationSend } from '../../../../../packages/pdf-structure/src/translate'
import { runPdfTranslation, type PdfTranslateBridge } from '../../shared/translate-pdf'
import { runOcr, type OcrBridge } from '../../shared/translate-ocr'
import type { createChatOcrModel } from './ocr-chat-model'

export interface BatchMediaRoute {
  provider: string
  model: string
  paid: boolean
}

export function createBatchTextModel(
  settings: () => AiSettings,
  statuses: () => AiSubscriptionStatuses,
  owner: number,
) {
  function current() {
    const value = settings()
    const gate = aiSendGate(value, statuses())
    if (gate.kind !== 'run') throw new Error('Check the AI connection in Settings.')
    const provider = gate.choice.provider
    const config = value.providers[provider]
    if (!config) throw new Error('No model is configured.')
    const route = {
      provider,
      model: config.model,
      paid: gate.choice.metered || !isSubscriptionProvider(provider),
    }
    return { provider, config, route }
  }
  const confirmed = current()
  const send: TranslationSend = async (request, signal) => {
    const now = current()
    if (JSON.stringify(confirmed.route) !== JSON.stringify(now.route))
      throw new Error('The selected AI connection has changed.')
    const refusal = aiRunRefusal({
      senderId: owner,
      provider: now.provider,
      model: now.config.model,
    })
    if (refusal) throw new Error(refusal)
    signal.throwIfAborted()
    let answer = ''
    await streamForProvider(
      now.provider,
      now.config,
      request.system,
      [{ role: 'user', text: request.prompt }],
      [],
      8192,
      {
        signal,
        onDelta: (part) => {
          answer += part
        },
        onToolCall: () => {
          throw new Error('Unexpected translation tool call.')
        },
      },
    )
    return answer
  }
  return { route: confirmed.route, send }
}

export interface ProjectBatchMediaDeps {
  text(owner: number): ReturnType<typeof createBatchTextModel>
  ocr: ReturnType<typeof createChatOcrModel>
  confirm(input: {
    kind: 'pdf' | 'ocr'
    route: BatchMediaRoute
    count: number
    total: number
    file: string
  }): Promise<boolean>
}

export async function runBatchMedia(options: {
  dir: string
  project: ProjectFile
  source: SourceEntry
  owner: number
  signal: AbortSignal
  pdf: () => PdfTranslateBridge
  ocr: () => OcrBridge
  media: ProjectBatchMediaDeps
  confirm: (kind: 'pdf' | 'ocr', route: BatchMediaRoute, count: number) => Promise<boolean>
  progress: (done: number, total: number, verified?: boolean) => void
}): Promise<{ kind: 'saved'; name: string } | { kind: 'edit'; path: string }> {
  const { dir, source, owner, signal, progress, media } = options
  if (source.kind === 'pdf') {
    // A completed result in the PDF store can be written while offline.
    let connection: ReturnType<ProjectBatchMediaDeps['text']> | undefined
    let unavailable: unknown
    try {
      connection = media.text(owner)
    } catch (err) {
      unavailable = err
    }

    const bridge = options.pdf()
    const result = await runPdfTranslation({
      dir,
      file: source.file,
      bridge,
      model: () => connection?.route ?? { provider: '', model: '' },
      signal,
      completeOnly: true,
      confirm: async ({ resume }) => {
        if (resume.calls === 0)
          return {
            model: connection?.route ?? resume.model,
            restart: false,
            bilingual: false,
            send: () => Promise.reject(new Error('No model call was requested.')),
          }
        if (!connection) throw unavailable
        const { route, send } = connection
        if (!(await options.confirm('pdf', route, resume.calls))) return null
        return { model: route, send, restart: false, bilingual: false }
      },
      onProgress: ({ done, total }) => progress(done, total),
      onWriting: ({ done, total }) => progress(done, total, done === total),
    })
    if (result.token) await bridge.release(result.token)
    if (!result.output) throw new Error('The PDF translation is incomplete.')
    return { kind: 'saved', name: result.output }
  }
  if (options.project.ocr?.kind !== 'ai') throw new Error('OCR is disabled in this project.')
  const provider = options.project.ocr
  const route = media.ocr.route(provider)
  const result = await runOcr({
    dir,
    source,
    bridge: options.ocr(),
    selection: { kind: 'all' },
    signal,
    confirm: (count) => options.confirm('ocr', route, count),
    ask: (requested, request, s) => {
      if (requested !== provider.provider) throw new Error('The OCR connection has changed.')
      return media.ocr.ask(route, request, s, owner)
    },
    onSettled: (outcome) => {
      signal.throwIfAborted()
      if (outcome.failures.length || outcome.stopped)
        throw new Error('The OCR reading is incomplete.')
    },
    onProgress: ({ done, total }) => progress(done, total),
  })
  signal.throwIfAborted()
  if (result.failed.length || result.stopped) throw new Error('The OCR reading is incomplete.')
  return { kind: 'edit', path: result.outputPath }
}
