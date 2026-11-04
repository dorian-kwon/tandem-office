import {
  streamForProvider,
  isSubscriptionProvider,
  type AiSettings,
  type AiSubscriptionStatuses,
  type AiSubscriptionProviderId,
} from '@genoffice/ai-provider'
import { aiSendGate } from '../../../../../packages/ui/src/ai-send-gate'
import { aiReadVisionCheck } from '../../../../../packages/pdf-structure/src/ai-read/vision'
import { aiRunRefusal } from '@genoffice/electron-utils/ai-run-guard'
import type { ChatOcrRoute } from './ocr-chat'
import type { AiReadRequest } from '../../../../../packages/pdf-structure/src/ai-read/instruction'

/** Reuse the app's send gate and current subscription route; never choose a key provider. */
export function createChatOcrModel(deps: {
  settings: () => AiSettings
  statuses: () => AiSubscriptionStatuses
}) {
  function bound(provider: AiSubscriptionProviderId) {
    const settings = deps.settings()
    const gate = aiSendGate({ ...settings, provider }, deps.statuses())
    if (gate.kind !== 'run' || gate.choice.provider !== provider)
      throw new Error('OCR subscription is not ready or its notice is unread')
    const config = settings.providers[provider]
    if (!config || !aiReadVisionCheck(provider, config.model).ok)
      throw new Error('The OCR model must support images')
    return { settings, config, route: { provider, model: config.model, paid: gate.choice.metered } }
  }
  return {
    route(ocr: { kind: 'ai'; provider: 'claude' | 'chatgpt' }): ChatOcrRoute {
      if (ocr.provider === 'claude') return bound('claude-code').route
      const selected = deps.settings().provider
      const provider =
        selected === 'codex' || selected === 'chatgpt'
          ? selected
          : deps.statuses().chatgpt?.state === 'ready'
            ? 'chatgpt'
            : 'codex'
      return bound(provider).route
    },
    async ask(
      route: ChatOcrRoute,
      request: AiReadRequest,
      signal: AbortSignal,
      owner: number,
    ): Promise<string> {
      if (!isSubscriptionProvider(route.provider))
        throw new Error('OCR requires the selected subscription')
      const current = bound(route.provider)
      if (JSON.stringify(current.route) !== JSON.stringify(route))
        throw new Error('OCR connection or cost changed')
      const refusal = aiRunRefusal({
        senderId: owner,
        provider: route.provider,
        model: route.model,
      })
      if (refusal) throw new Error('The document cannot be sent through this AI connection')
      signal.throwIfAborted()
      let text = ''
      await streamForProvider(
        route.provider,
        current.config,
        request.system,
        request.messages,
        [],
        8192,
        {
          signal,
          onDelta: (part) => {
            text += part
            if (text.length > 200000) throw new Error('OCR response limit exceeded')
          },
          onToolCall: () => {
            throw new Error('OCR never offers tools')
          },
        },
      )
      return text
    },
  }
}
