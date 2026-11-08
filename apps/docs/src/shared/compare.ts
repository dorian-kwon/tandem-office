import type { CompareSite } from './compare-sites'

/** IPC channels of the AI compare feature (renderer to main) */
export const COMPARE_CHANNELS = {
  detect: 'compare:detect',
  ask: 'compare:ask',
  cancel: 'compare:cancel',
  readSource: 'compare:read-source',
  getConsent: 'compare:get-consent',
  setConsent: 'compare:set-consent',
  getPrefs: 'compare:get-prefs',
  setPrefs: 'compare:set-prefs',
} as const

/**
 * Reasons the driver reports as codes (everything else in `reason` is a short diagnostic for
 * people). Each of these means the site cannot be used right now and the engine is BLOCKED for
 * the rest of the run: it is shown as blocked and never retried by itself or worked around.
 * - `login-wall`: a redirect to a login or sign-up page, or a wall covering the prompt box
 * - `needs-user`: ego lite handed the space to the person (a browser permission prompt, a cookie
 *   notice over the box); they handle it in ego lite and start again
 * - `blocked`: a CAPTCHA or "unusual traffic" page
 * Missing prompt boxes and failed input/send interactions are ordinary failures, not site blocks.
 * A logged-out site whose prompt box works (guest chat) is simply used.
 */
export const COMPARE_LOGIN_WALL = 'login-wall'
export const COMPARE_NO_PROMPT_BOX = 'no-prompt-box'
export const COMPARE_NEEDS_USER = 'needs-user'
export const COMPARE_BLOCKED = 'blocked'

/** the reasons that block an engine for the rest of the run */
export function isBlockReason(reason: string): boolean {
  return (
    reason === COMPARE_LOGIN_WALL || reason === COMPARE_NEEDS_USER || reason === COMPARE_BLOCKED
  )
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

/** the popup's remembered choices (web-compare.json), all optional */
export interface ComparePrefs {
  /** engine id to on/off; an engine without an entry is on */
  engines?: Record<string, boolean>
  /** our own AI integrates the answers of each unit */
  autoIntegrate?: boolean
}
