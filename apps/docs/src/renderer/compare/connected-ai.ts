import type { AgentTransport } from '@genoffice/agent-core'
import {
  AI_PROVIDERS,
  AI_SUBSCRIPTION_PROVIDERS,
  providerSelectionOf,
  isSubscriptionProvider,
  subscriptionStateOf,
  type AiSettings,
  type AiSubscriptionStatuses,
} from '@genoffice/ai-provider/browser'
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

export interface ConnectedComparison {
  id: string
  name: string
  metered: boolean
  settings: AiSettings
}

export interface ConnectedComparisons {
  candidates: ConnectedComparison[]
  main?: ConnectedComparison | undefined
  checking: boolean
}

/**
 * Only subscription logins are discovered automatically. A paid route enters
 * the run only when it is the explicitly selected main AI, never because its
 * credentials happen to be saved. Every route passes the normal send gate.
 */
export function enumerateConnectedComparisons(
  settings: AiSettings,
  statuses: AiSubscriptionStatuses,
): ConnectedComparisons {
  const candidates: ConnectedComparison[] = []
  const selection = providerSelectionOf(settings)
  const capture = (provider: AiSettings['provider']): ConnectedComparison | undefined => {
    const pinned = structuredClone({ ...settings, provider })
    const gate = aiSendGate(pinned, statuses)
    if (gate.kind !== 'run') return undefined
    pinned.provider = gate.choice.provider
    // Discovery does not authorize a later switch from subscription to paid login.
    if (isSubscriptionProvider(gate.choice.provider) && selection !== gate.choice.provider)
      pinned.meteredAccepted = { ...pinned.meteredAccepted, [gate.choice.provider]: false }
    const label =
      AI_PROVIDERS.find((p) => p.id === gate.choice.provider)?.label ?? gate.choice.provider
    const model = pinned.providers[gate.choice.provider]?.model?.trim()
    return {
      id: `connected-${gate.choice.provider}`,
      name: model ? `${label} · ${model}` : label,
      metered: gate.choice.metered,
      settings: pinned,
    }
  }
  for (const provider of AI_SUBSCRIPTION_PROVIDERS) {
    // Accepted metered logins still require an explicit selection.
    if (statuses[provider]?.state !== 'ready') continue
    const candidate = capture(provider)
    if (candidate) candidates.push(candidate)
  }
  const main = capture(settings.provider)
  if (main && providerSelectionOf(settings) !== 'auto' && !candidates.some((c) => c.id === main.id))
    candidates.push(main)
  return {
    candidates,
    main,
    checking:
      AI_SUBSCRIPTION_PROVIDERS.some(
        (provider) => subscriptionStateOf(statuses, provider) === 'checking',
      ) || aiSendGate(settings, statuses).kind === 'checking',
  }
}

interface PinnedConnectedCompareDeps {
  settings: AiSettings
  getStatuses(): AiSubscriptionStatuses
  transportFor(settings: AiSettings): AgentTransport
  unavailableText(): string
}

/** A separate transport per request isolates concurrent streams and provider sessions. */
export function createPinnedConnectedCompareAsk(deps: PinnedConnectedCompareDeps) {
  const settings = structuredClone(deps.settings)
  const initial = aiSendGate(settings, deps.getStatuses())
  if (initial.kind === 'run') settings.provider = initial.choice.provider
  return async (prompt: string, signal: AbortSignal): Promise<CompareAnswer> => {
    if (signal.aborted) return { ok: false, reason: 'stopped' }
    if (initial.kind !== 'run' || aiSendGate(settings, deps.getStatuses()).kind !== 'run')
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
