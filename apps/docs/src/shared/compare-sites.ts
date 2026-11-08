/**
 * The web destinations used by AI compare (Copilot). The app's connected AI uses its
 * existing renderer transport; the complete engine ID list lives in compare-engines.ts.
 * Browser selectors and timing settings belong only in this table.
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
]

export type CompareSiteId = (typeof COMPARE_SITES)[number]['id']

export function compareSiteById(id: string): CompareSite | undefined {
  return COMPARE_SITES.find((site) => site.id === id)
}

/** where a person is sent to install ego lite (opened through the safe external URL gate) */
export const EGO_INSTALL_URL = 'https://github.com/citrolabs/ego-lite'
