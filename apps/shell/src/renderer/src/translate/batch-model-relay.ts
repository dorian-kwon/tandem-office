import {
  createIpcTransport,
  type AgentStreamHandle,
  type AgentTransport,
} from '@genoffice/agent-core'
import {
  localContextLimit,
  localModelCapabilities,
  type AiSettings,
} from '@genoffice/ai-provider/browser'
import { aiContextConfirmText, aiRunErrorText } from '@genoffice/ui'
import type { BatchModelPayload, BatchModelRelay } from '../../../shared/batch-model-relay'
import type { HomeApi } from '../../../shared/home-api'
import type { SubscriptionApi } from '../../../shared/subscription-api'
import { strings } from '../strings'
import { pdfJobRoute, pdfRouteRefusal, type PdfJobRoute } from './pdf-route'

interface Session {
  transport?: AgentTransport
  route?: Extract<PdfJobRoute, { state: 'ready' }>
  turns: Map<string, { handle?: AgentStreamHandle }>
}

/** A provider stream belongs to the shell, so a project panel may unmount during the run. */
export function installBatchModelRelay(
  bridge: BatchModelRelay,
  home: Pick<
    HomeApi,
    'onAiStream' | 'aiStream' | 'aiStreamCancel' | 'aiGetSettings' | 'getLanguage'
  >,
  subscription: Pick<SubscriptionApi, 'statuses'> | undefined,
  confirm: (message: string) => boolean,
) {
  const sessions = new Map<string, Session>()
  return bridge.onCommand((command) => {
    const { session: id } = command
    if (command.kind === 'close') {
      const session = sessions.get(id)
      sessions.delete(id)
      for (const turn of session?.turns.values() ?? []) turn.handle?.cancel()
      session?.turns.clear()
      return
    }
    const { turn } = command
    if (command.kind === 'cancel') {
      const turns = sessions.get(id)?.turns
      const current = turns?.get(turn)
      turns?.delete(turn)
      current?.handle?.cancel()
      return
    }
    const session: Session = sessions.get(id) ?? { turns: new Map() }
    if (session.turns.has(turn)) return
    sessions.set(id, session)
    const current: { handle?: AgentStreamHandle } = {}
    session.turns.set(turn, current)
    const report = (payload: BatchModelPayload) => {
      if (session.turns.get(turn) !== current) return
      if (payload.kind === 'error' || payload.kind === 'done') session.turns.delete(turn)
      bridge.report({ session: id, turn, ...payload })
    }
    void (async () => {
      const [settings, statuses, lang] = await Promise.all([
        home.aiGetSettings(),
        subscription?.statuses(),
        home.getLanguage(),
      ])
      if (session.turns.get(turn) !== current) return
      const route = pdfJobRoute(settings, statuses)
      if (
        route.state !== 'ready' ||
        !statuses ||
        (session.route && pdfRouteRefusal(session.route, settings, statuses))
      ) {
        throw new Error(
          route.state === 'connect'
            ? (aiRunErrorText(lang, { kind: route.choice.errorKind }) ??
                strings[lang].askUnknownError)
            : strings[lang].askUnknownError,
        )
      }
      // Pin the settings/provider once across every tool round. Each new round
      // re-reads current subscription and payment status before using that route.
      const pinned = (session.route ??= route)
      const transport = (session.transport ??= createIpcTransport<AiSettings>({
        onStream: (listener) => home.onAiStream(listener),
        start: (request) => home.aiStream(request),
        cancel: (requestId) => {
          void home.aiStreamCancel(requestId, 'request').catch(() => {})
        },
        getSettings: () => pinned.settings,
        unknownErrorText: () => strings[lang].askUnknownError,
        errorText: (cause) => aiRunErrorText(lang, cause),
        contextLimit: localContextLimit,
        confirmContext: (warning) => confirm(aiContextConfirmText(lang, warning)),
      }))
      report({ kind: 'started' })
      const request =
        localModelCapabilities(pinned.settings).tools === false
          ? { ...command.request, tools: [] }
          : command.request
      current.handle = transport.stream(request, {
        onDelta: (text) => report({ kind: 'delta', text }),
        onReasoning: (text) => report({ kind: 'reasoning', text }),
        onToolCall: (call) => report({ kind: 'tool-call', call }),
        onPhase: (phase) => report({ kind: 'phase', phase }),
        onUsage: (usage) => report({ kind: 'usage', usage }),
        onStopReason: (text) => report({ kind: 'stop-reason', text }),
        onError: (text) => report({ kind: 'error', text }),
        onDone: () => report({ kind: 'done' }),
      })
    })().catch((err) =>
      report({ kind: 'error', text: err instanceof Error ? err.message : String(err) }),
    )
  })
}
