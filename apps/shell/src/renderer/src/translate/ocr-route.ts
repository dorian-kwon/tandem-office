import type {
  AiProviderChoice,
  AiSettings,
  AiSubscriptionProviderId,
  AiSubscriptionStatuses,
} from '@genoffice/ai-provider/browser'
import { aiSendGate } from '@genoffice/ui'
import type { OcrProvider } from '../../../shared/translate-ocr'

/**
 * Which AI the translation OCR sends to (spec 6.5: "the app's provider
 * choice, with its own pick for OCR"). The project names Claude or ChatGPT;
 * this maps that onto one of the app's subscription connections and runs the
 * app's own send gate (`aiSendGate`) on settings pinned to it, the way the
 * PDF editor's document jobs pin their provider:
 *
 * - only subscription providers are candidates: a key provider is never used
 *   here, whatever the app-wide choice is;
 * - a metered login counts only when the person accepted it in Settings, and
 *   is then shown as paid;
 * - a provider that cannot run answers "connect", never another provider;
 * - the app-wide choice is not changed: the pinned copy goes only into the
 *   OCR requests.
 */

export type OcrRoute =
  | { state: 'checking' }
  | { state: 'connect'; choice: Extract<AiProviderChoice, { connected: false }> }
  /** the first-connection notice is unread: nothing starts before it is acknowledged */
  | { state: 'notice'; provider: AiSubscriptionProviderId }
  | {
      state: 'ready'
      provider: AiSubscriptionProviderId
      /** '' = the program's own default */
      model: string
      /** an accepted metered login: the person pays per call */
      paid: boolean
      /** the stored settings with the selection pinned to `provider` */
      settings: AiSettings
    }

const CHATGPT_CONNECTIONS: readonly AiSubscriptionProviderId[] = ['chatgpt', 'codex']

/** the subscription connection for the project's OCR choice */
export function ocrProviderId(
  ocr: OcrProvider,
  settings: Pick<AiSettings, 'provider'>,
  statuses: AiSubscriptionStatuses,
): AiSubscriptionProviderId {
  if (ocr === 'claude') return 'claude-code'
  // the ChatGPT connection the person chose for the app, when it is one
  const chosen = CHATGPT_CONNECTIONS.find((id) => id === settings.provider)
  if (chosen) return chosen
  return CHATGPT_CONNECTIONS.find((id) => statuses[id]?.state === 'ready') ?? 'chatgpt'
}

export function ocrRoute(
  ocr: OcrProvider,
  settings: AiSettings | null | undefined,
  statuses: AiSubscriptionStatuses | null | undefined,
): OcrRoute {
  if (!settings || !statuses) return { state: 'checking' }
  const provider = ocrProviderId(ocr, settings, statuses)
  const pinned: AiSettings = { ...settings, provider }
  const gate = aiSendGate(pinned, statuses)
  if (gate.kind === 'checking') return { state: 'checking' }
  if (gate.kind === 'connect') return { state: 'connect', choice: gate.choice }
  if (gate.kind === 'notice') return { state: 'notice', provider }
  return {
    state: 'ready',
    provider,
    model: settings.providers?.[provider]?.model?.trim() ?? '',
    paid: gate.choice.metered,
    settings: pinned,
  }
}
