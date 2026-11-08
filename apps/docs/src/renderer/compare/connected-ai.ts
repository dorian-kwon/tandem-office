import type { AgentTransport } from '@genoffice/agent-core'
import type { AiSettings, AiSubscriptionStatuses } from '@genoffice/ai-provider/browser'
import { aiSendGate } from '@genoffice/ui'
import type { CompareAnswer } from '../../shared/compare'
import { integrateComparison } from './integration'

interface ConnectedCompareDeps {
  getSettings(): Promise<AiSettings>
  getStatuses(): AiSubscriptionStatuses
  transportFor(settings: AiSettings): AgentTransport
  unavailableText(): string
}

/** One read-only candidate from the app's current connection; no provider override or fallback. */
export function createConnectedCompareAsk(deps: ConnectedCompareDeps) {
  return async (prompt: string, signal: AbortSignal): Promise<CompareAnswer> => {
    if (signal.aborted) return { ok: false, reason: 'stopped' }
    let settings: AiSettings
    try {
      settings = await deps.getSettings()
    } catch {
      return { ok: false, reason: deps.unavailableText() }
    }
    if (signal.aborted) return { ok: false, reason: 'stopped' }
    if (aiSendGate(settings, deps.getStatuses()).kind !== 'run')
      return { ok: false, reason: deps.unavailableText() }
    return integrateComparison(
      deps.transportFor(settings),
      {
        system:
          'Return only the requested comparison text. Do not execute tools or edit the document.',
        user: prompt,
      },
      signal,
    )
  }
}
