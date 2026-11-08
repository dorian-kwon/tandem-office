import type { CompareSite } from './compare-sites'

/** IPC channels of the AI compare feature (renderer to main) */
export const COMPARE_CHANNELS = {
  detect: 'compare:detect',
  ask: 'compare:ask',
  cancel: 'compare:cancel',
  readSource: 'compare:read-source',
  getConsent: 'compare:get-consent',
  setConsent: 'compare:set-consent',
  getRetranslate: 'compare:get-retranslate',
  setRetranslate: 'compare:set-retranslate',
} as const

/**
 * Reasons the driver reports as codes (everything else in `reason` is a short
 * diagnostic for people). An engine is SKIPPED, quietly and without retry loops, only
 * when chatting is impossible: the site sent us to a login or sign-up page, a login or
 * consent wall covers the prompt box, or no prompt box shows up within the bounded wait.
 * A logged-out site whose prompt box works (guest chat) is simply used. `needs-user`:
 * ego lite handed the space to the person (a browser permission prompt); they handle it
 * in ego lite and may press Retry, nothing is retried around it.
 */
export const COMPARE_LOGIN_WALL = 'login-wall'
export const COMPARE_NO_PROMPT_BOX = 'no-prompt-box'
export const COMPARE_NEEDS_USER = 'needs-user'

/** the reasons that mean "left out, not an error" */
export function isSkipReason(reason: string): boolean {
  return reason === COMPARE_LOGIN_WALL || reason === COMPARE_NO_PROMPT_BOX
}

export type CompareAnswer = { ok: true; text: string } | { ok: false; reason: string }

export interface EgoDetection {
  installed: boolean
  /** the verified `ego-browser` executable */
  path?: string
}

/**
 * The only thing the rest of the feature knows about the web part. The real
 * implementation drives ego lite (`ego-driver.ts`); tests use a fake.
 */
export interface CompareDriver {
  ask(site: CompareSite, prompt: string, signal: AbortSignal): Promise<CompareAnswer>
  detect(): Promise<EgoDetection>
}

/** the renderer's view of the driver: sites are named by id, the work happens in the main process */
export interface CompareDriverClient {
  ask(siteId: string, prompt: string, signal: AbortSignal): Promise<CompareAnswer>
  detect(): Promise<EgoDetection>
}

/** answer of `compare:read-source` */
export type CompareSourceBytes = { ok: true; bytes: Uint8Array } | { ok: false }
