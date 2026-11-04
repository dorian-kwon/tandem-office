import {
  createIpcTransport,
  type AgentStreamHandle,
  type AgentStreamRequest,
  type IpcStreamError,
} from '@genoffice/agent-core'
import type { AiSettings } from '@genoffice/ai-provider/browser'
import type { Lang } from '@genoffice/i18n'
import { aiRunErrorText } from '@genoffice/ui'
import type { AiStreamChunk, AiStreamRequest } from '@genoffice/ai-provider'
import type { OcrAsk, OcrProvider } from '../../../shared/translate-ocr'
import { asPictureRequest } from '../../../shared/ocr-picture-instruction'
import { translateText } from '../i18n/strings-translate'
import type { OcrRoute } from './ocr-route'

/**
 * One OCR model call over the shared `ai:stream` channel, the request path of
 * every AI panel of the app (the home ask uses the same bridge): the reading
 * instruction and one page image, no tools. The main process decides the
 * provider from the settings the request carries (pinned to the confirmed
 * route) and refuses what cannot run, as for any other request.
 *
 * Before each call the route is looked at again: when it is no longer the
 * confirmed one (another provider, newly paid, not connected) the call fails
 * with a stop kind and the run ends, never moving to another provider.
 * The answer is plain text for the engine's parser; a tool call is ignored.
 */

/** longest answer one page may return (a dense page is far below it) */
export const OCR_ANSWER_MAX_CHARS = 200_000

export class OcrCallError extends Error {
  readonly kind?: string
  readonly resetsAt?: number
  constructor(text: string, cause?: { kind?: string; resetsAt?: number }) {
    super(text)
    this.name = 'OcrCallError'
    if (cause?.kind !== undefined) this.kind = cause.kind
    if (cause?.resetsAt !== undefined) this.resetsAt = cause.resetsAt
  }
}

/** the part of the home bridge (`window.aiOffice`) a call needs */
export interface OcrStreamBridge {
  aiStream(request: AiStreamRequest): Promise<void>
  aiStreamCancel(requestId: string, scope?: 'request'): Promise<void>
  onAiStream(handler: (chunk: AiStreamChunk) => void): () => void
}

export interface OcrAskOptions {
  /** what the person confirmed */
  confirmed: Extract<OcrRoute, { state: 'ready' }>
  /** the project's OCR choice the route was made for */
  ocr: OcrProvider
  /** the route right now (settings and statuses as the screen has them) */
  current: () => OcrRoute
  lang: () => Lang
  bridge?: OcrStreamBridge
  /** the images are pictures inside a document (text in drawings counts), not scanned pages */
  pictures?: boolean
}

const abortError = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException('The call was stopped', 'AbortError')

/** the confirmed route no longer holds: the run error kind to stop with, else null */
export function ocrRouteRefusal(
  confirmed: Extract<OcrRoute, { state: 'ready' }>,
  now: OcrRoute,
): string | null {
  if (now.state === 'checking') return null
  if (now.state === 'connect') return now.choice.errorKind
  if (now.state === 'notice') return 'not-connected'
  if (now.provider !== confirmed.provider || now.paid !== confirmed.paid) return 'not-connected'
  return null
}

export function createOcrAsk(o: OcrAskOptions): OcrAsk {
  const ask = createRouteAsk({
    settings: () => o.confirmed.settings,
    refusal: () => ocrRouteRefusal(o.confirmed, o.current()),
    lang: o.lang,
    unknownError: 'errOcrFailed',
    ...(o.bridge ? { bridge: o.bridge } : {}),
  })
  return async (provider, request, signal) => {
    if (signal.aborted) throw abortError(signal)
    if (provider !== o.ocr)
      throw new OcrCallError('another provider was asked for', { kind: 'not-connected' })
    const sent = o.pictures ? asPictureRequest(request) : request
    return ask(sent.system, sent.messages, signal)
  }
}

export interface RouteAskOptions {
  /** the settings the person confirmed (the selection pinned to one provider) */
  settings: () => AiSettings
  /** asked before each call: the run error kind to stop with when the route changed, else null */
  refusal: () => string | null
  lang: () => Lang
  /** the screen's text for a failure that names no reason */
  unknownError: 'errOcrFailed' | 'errTranslateFailed'
  bridge?: OcrStreamBridge
}

/**
 * One model call of a document job over `ai:stream`: a system prompt and
 * user turns, no tools, all calls of one job under one run id. Used by the
 * OCR and by the PDF translation of the translation tool.
 */
export function createRouteAsk(
  o: RouteAskOptions,
): (
  system: string,
  messages: AgentStreamRequest['messages'],
  signal: AbortSignal,
) => Promise<string> {
  const bridge: OcrStreamBridge = o.bridge ?? window.aiOffice
  const runId = crypto.randomUUID()
  return async (system, messages, signal) => {
    if (signal.aborted) throw abortError(signal)
    const refused = o.refusal()
    if (refused)
      throw new OcrCallError(`the confirmed AI connection changed (${refused})`, { kind: refused })
    return new Promise<string>((resolve, reject) => {
      let cause: IpcStreamError | null = null
      let raw = ''
      let settled = false
      let handle: AgentStreamHandle | null = null
      const finish = (end: () => void) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        end()
      }
      const onAbort = () => {
        handle?.cancel()
        finish(() => reject(abortError(signal)))
      }
      const settings = o.settings()
      const transport = createIpcTransport<AiSettings>({
        onStream: (listener) => bridge.onAiStream(listener as (chunk: AiStreamChunk) => void),
        start: (req) => bridge.aiStream(req as unknown as AiStreamRequest),
        // Stop ends this call only, not media calls the home window may be making
        cancel: (requestId) => void bridge.aiStreamCancel(requestId, 'request'),
        getSettings: () => settings,
        unknownErrorText: () => translateText(o.lang(), o.unknownError),
        errorText: (c) => aiRunErrorText(o.lang(), c),
        onStreamError: (error) => {
          cause = error
        },
      })
      handle = transport.stream(
        { system, messages, tools: [], runId },
        {
          onDelta: (text) => {
            if (settled) return
            raw += text
            if (raw.length > OCR_ANSWER_MAX_CHARS) {
              handle?.cancel()
              finish(() => reject(new OcrCallError('the answer was too long')))
            }
          },
          // the request offers no tool; whatever the model asks for is not run
          onToolCall: () => undefined,
          onDone: () => finish(() => (signal.aborted ? reject(abortError(signal)) : resolve(raw))),
          onError: (message) =>
            finish(() =>
              reject(
                new OcrCallError(
                  message,
                  cause
                    ? { kind: cause.kind, ...(cause.resetsAt ? { resetsAt: cause.resetsAt } : {}) }
                    : undefined,
                ),
              ),
            ),
        },
      )
      if (settled) return
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
  }
}
