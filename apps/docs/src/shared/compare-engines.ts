import { AI_PROVIDERS, type AiProviderId } from '@genoffice/ai-provider/browser'

/** App candidates route through pinned provider settings, never through the browser driver. */
export const COMPARE_ENGINE_IDS: readonly string[] = [
  'copilot',
  ...AI_PROVIDERS.map((provider) => `connected-${provider.id}`),
]
export type CompareEngineId = 'copilot' | `connected-${AiProviderId}`
