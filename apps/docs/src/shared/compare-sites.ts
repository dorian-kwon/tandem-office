/**
 * The one table of the web AIs the "AI compare" popup asks (Copilot and ChatGPT; Gemini and Claude
 * were taken out). Every engine of the feature (switches, status chips, candidate cards,
 * prompts, retry, the driver) is derived from COMPARE_SITES, so a site is added or removed by
 * editing this list only.
 *
 * Page details were checked on the real sites with `tools/ego-probe.mjs`; correct them there
 * when a site changes its page.
 *
 * Plain data only (strings, numbers): the entry is embedded as
 * JSON into the script that runs inside ego lite.
 */
export interface CompareSite {
  /** stable id used in IPC and state */
  id: string
  /** product name shown on cards and rows (a plain name, never a logo) */
  name: string
  /** page the conversation is started on */
  url: string
  /** selector of the prompt input (a CSS selector, or any ego-browser selector form) */
  inputSelector: string
  /**
   * how the prompt gets in: `insertText` (click the input, then keyboard.insertText),
   * `paste` (click, then keyboard.paste: restores the clipboard afterwards), or `fill`
   * (page.fill, for plain textareas)
   */
  inputMode: 'insertText' | 'paste' | 'fill'
  /** `enter`: press Enter in the input; `button`: click `submitSelector` */
  submit: 'enter' | 'button'
  /** selector of the send button (used by `submit: 'button'`) */
  submitSelector: string
  /** selector that matches only while the site is still writing (the stop button); '' = none */
  busySelector: string
  /** selector matching every assistant message; the last match is the answer */
  answerSelector: string
  /**
   * regex source (case-insensitive) matched against the page URL: a match means the site
   * sent us to a login or sign-up page, so chatting is impossible (checked before anything is sent)
   */
  loggedOutUrl: string
  /**
   * regex source (case-insensitive) of page text that explains a missing prompt box as a login
   * wall. Used only when no usable prompt box shows up: sign-in buttons next to a working box
   * (a guest session) are NOT a signal.
   */
  loginHint: string
  /** Reject an explicit login button even when the site offers a guest composer. */
  requiresLogin?: boolean
  /** A visible signed-in account control must exist before using a login-only site. */
  sessionSelector?: string
  /** how long to wait for the input to show up after the page opens */
  loadTimeoutMs: number
  /** the longest the site may take to finish its answer */
  answerTimeoutMs: number
  /** the answer counts as complete after its text stayed unchanged this long */
  settleMs: number
  /** false until the page details were checked against the real site */
  verified: boolean
}

export const COMPARE_SITES: readonly CompareSite[] = [
  {
    id: 'copilot',
    name: 'Copilot',
    url: 'https://copilot.com/chat',
    inputSelector: '#m365-chat-editor-target-element',
    inputMode: 'insertText',
    submit: 'button',
    // the send button is named by its label ("보내기" in the Korean UI); only used when Enter did not send
    submitSelector:
      'button[aria-label="보내기"], button[aria-label="Send"], button[aria-label="Submit"]',
    // no stop button was seen while it wrote: completion is the answer text staying unchanged
    busySelector: '',
    answerSelector: '[data-testid="markdown-reply"]',
    // logged out, /chat lands on a locale page (/ko-kr) with a login button, or on a Microsoft sign-in
    loggedOutUrl:
      '^https://(www\\.)?copilot\\.com/[a-z]{2}-[a-z]{2}\\b|login\\.microsoftonline\\.com|login\\.live\\.com',
    loginHint: 'sign in|로그인',
    loadTimeoutMs: 30_000,
    answerTimeoutMs: 120_000,
    settleMs: 3_000,
    // checked 2026-11-08 on the real site: input, Enter, answer element
    verified: true,
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    url: 'https://chatgpt.com/',
    inputSelector: '#prompt-textarea',
    inputMode: 'insertText',
    submit: 'button',
    submitSelector: 'button[data-testid="send-button"]',
    busySelector: 'button[data-testid="stop-button"]',
    answerSelector: '[data-message-author-role="assistant"] .markdown',
    loggedOutUrl: 'auth\\.openai\\.com|auth\\.chatgpt\\.com|/auth/|/login|/sign-in|/sign-up',
    loginHint: '^(log in|sign in|로그인)$',
    requiresLogin: true,
    sessionSelector: '[data-testid="accounts-profile-button"]',
    loadTimeoutMs: 30_000,
    answerTimeoutMs: 120_000,
    settleMs: 3_000,
    // Checked 2026-11-09: the guest page has a usable mobile composer and explicit login
    // buttons. An existing signed-in session is required; signed-in selectors await a check.
    verified: false,
  },
]

export type CompareSiteId = (typeof COMPARE_SITES)[number]['id']

export function compareSiteById(id: string): CompareSite | undefined {
  return COMPARE_SITES.find((site) => site.id === id)
}

/** where a person is sent to install ego lite (opened through the safe external URL gate) */
export const EGO_INSTALL_URL = 'https://github.com/citrolabs/ego-lite'
