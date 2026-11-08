/**
 * The one table of the web AIs the "AI compare" popup asks. Every engine of the
 * feature (status rows, candidate cards, prompts, retry, the driver) is derived
 * from COMPARE_SITES, so a site is added or removed by editing this list only.
 *
 * The page details (how to find the input, how to submit, when the answer is
 * complete) could not be tried against the real sites when they were written:
 * every entry is `verified: false` until someone runs `tools/ego-probe.mjs` on a
 * machine with ego lite installed and corrects the values here.
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
    id: 'gemini',
    name: 'Gemini',
    url: 'https://gemini.google.com/app',
    inputSelector: 'div.ql-editor[contenteditable]',
    inputMode: 'insertText',
    submit: 'enter',
    submitSelector: 'button[aria-label*="Send"]',
    busySelector: 'button[aria-label*="Stop"]',
    answerSelector: 'message-content',
    loggedOutUrl: 'accounts\\.google\\.com',
    loginHint: 'sign in|로그인',
    loadTimeoutMs: 30_000,
    answerTimeoutMs: 120_000,
    settleMs: 3_000,
    verified: false,
  },
  {
    id: 'claude',
    name: 'Claude',
    url: 'https://claude.ai/new',
    inputSelector: 'div[data-testid="chat-input"]',
    inputMode: 'insertText',
    submit: 'enter',
    submitSelector: 'button[aria-label*="Send"]',
    busySelector: 'button[aria-label*="Stop"]',
    answerSelector: '.font-claude-response',
    loggedOutUrl: 'claude\\.ai/(login|signup)',
    loginHint: 'log in|sign in|continue with|로그인',
    loadTimeoutMs: 30_000,
    answerTimeoutMs: 120_000,
    settleMs: 3_000,
    verified: false,
  },
  {
    id: 'copilot',
    name: 'Copilot',
    url: 'https://copilot.com/chat',
    inputSelector: '#m365-chat-editor-target-element',
    inputMode: 'insertText',
    submit: 'enter',
    submitSelector: 'button[aria-label*="Send"], button[data-testid="submit-button"]',
    busySelector: 'button[aria-label*="Stop"], button[data-testid="stop-button"]',
    answerSelector: '[data-content="ai-message"]',
    // logged out, /chat lands on a locale page (/ko-kr) with a login button, or on a Microsoft sign-in
    loggedOutUrl:
      '^https://(www\\.)?copilot\\.com/[a-z]{2}-[a-z]{2}\\b|login\\.microsoftonline\\.com|login\\.live\\.com',
    loginHint: 'sign in|로그인',
    loadTimeoutMs: 30_000,
    answerTimeoutMs: 120_000,
    settleMs: 3_000,
    verified: false,
  },
  {
    id: 'grok',
    name: 'Grok',
    url: 'https://grok.com/',
    inputSelector: 'div.tiptap.ProseMirror',
    inputMode: 'insertText',
    submit: 'enter',
    submitSelector: 'button[type="submit"]',
    busySelector: 'button[aria-label*="Stop"]',
    answerSelector: '.message-bubble',
    loggedOutUrl: 'accounts\\.x\\.ai|/sign-in|/sign-up|/login',
    loginHint: 'sign in|log in|로그인',
    loadTimeoutMs: 30_000,
    answerTimeoutMs: 120_000,
    settleMs: 3_000,
    verified: false,
  },
]

export type CompareSiteId = (typeof COMPARE_SITES)[number]['id']

export function compareSiteById(id: string): CompareSite | undefined {
  return COMPARE_SITES.find((site) => site.id === id)
}

/** where a person is sent to install ego lite (opened through the safe external URL gate) */
export const EGO_INSTALL_URL = 'https://github.com/citrolabs/ego-lite'
