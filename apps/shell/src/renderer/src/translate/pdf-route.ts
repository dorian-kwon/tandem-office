import type {
  AiProviderChoice,
  AiSettings,
  AiSubscriptionStatuses,
} from '@genoffice/ai-provider/browser'
import { aiSendGate } from '@genoffice/ui'
import {
  documentJobRoute,
  jobRouteRefusal,
  type DocumentJobRoute,
} from '../../../../../pdf/src/renderer/doc-jobs/route'

/**
 * Which AI the translation of a text PDF sends to: the PDF editor's document
 * job route (`documentJobRoute`), unchanged. The provider is the app's own
 * choice (`selectAiProvider`), pinned for the whole job; a key provider or an
 * accepted metered login is paid and named so in the confirmation; nothing
 * moves to another provider by itself. In front of it sits the app's send
 * gate for the first-connection notice, as in the editors' job windows.
 */
export type PdfJobRoute =
  | { state: 'checking' }
  | { state: 'connect'; choice: Extract<AiProviderChoice, { connected: false }> }
  /** the first-connection notice is unread: nothing starts before it is acknowledged */
  | { state: 'notice' }
  | Extract<DocumentJobRoute, { state: 'ready' }>

export function pdfJobRoute(
  settings: AiSettings | null | undefined,
  statuses: AiSubscriptionStatuses | null | undefined,
): PdfJobRoute {
  const route = documentJobRoute(settings, statuses)
  if (route.state === 'checking') return route
  if (route.state === 'not-connected') return { state: 'connect', choice: route.choice }
  if (aiSendGate(settings, statuses).kind === 'notice') return { state: 'notice' }
  return route
}

/**
 * The run error kind to stop with when the confirmed route no longer holds
 * (not connected any more, or newly paid), else null. The job stays on its
 * confirmed provider even if the app-wide choice moves meanwhile.
 */
export function pdfRouteRefusal(
  confirmed: Extract<PdfJobRoute, { state: 'ready' }>,
  settings: AiSettings | null,
  statuses: AiSubscriptionStatuses | null,
): string | null {
  return jobRouteRefusal(confirmed, settings, statuses)
}
