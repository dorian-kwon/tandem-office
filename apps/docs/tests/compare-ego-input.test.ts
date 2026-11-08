import { Script } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { buildEgoScript, parseEgoOutput } from '../src/main/compare/ego-script'
import { compareSiteById } from '../src/shared/compare-sites'
import { isBlockReason } from '../src/shared/compare'

async function runInput(
  options: {
    acceptInput?: boolean
    inputDelay?: number
    enableSend?: boolean
    siteId?: string
    loggedOut?: boolean
    missingSession?: boolean
    sessionDelay?: number
  } = {},
) {
  const site = compareSiteById(options.siteId ?? 'copilot')!
  const prompt = 'A neutral test prompt'
  // A candidate signed-in ChatGPT DOM fixture. This checks actual CSS matching, without
  // claiming these attributes have been verified against a signed-in production session.
  const fixture = document.implementation.createHTMLDocument()
  fixture.body.innerHTML =
    '<button data-testid="accounts-profile-button"></button><div id="prompt-textarea" contenteditable="true"></div><button data-testid="send-button"></button><div data-message-author-role="assistant"><div class="markdown"></div></div>'
  const selectorMatches = (selector: string, role: string) =>
    site.id !== 'chatgpt' || fixture.querySelector(selector) === fixture.querySelector(role)

  let time = 0
  let rawInput = ''
  let pendingInput = ''
  let sent = 0
  let entered = 0
  let inserted = 0
  let output = ''
  const sends: Array<{ time: number; text: string }> = []
  const normalize = (s: string) =>
    s
      .replace(/\u200b|\u200c|\u200d|\u2060|\ufeff/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  const input = {
    get innerText() {
      return rawInput
    },
    get textContent() {
      return rawInput
    },
    isContentEditable: true,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 40 }),
    getAttribute: (name: string) => (name === 'contenteditable' ? 'true' : null),
  }
  const button = {
    get disabled() {
      return options.enableSend === false || normalize(rawInput) === ''
    },
    getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 300, top: 0, width: 20, height: 40 }),
  }
  const answer = { innerText: 'Answer', textContent: 'Answer' }
  const doc = {
    body: { innerText: '' },
    elementFromPoint: () => input,
    querySelector(selector: string) {
      if (site.sessionSelector && selector === site.sessionSelector)
        return options.missingSession ||
          time < (options.sessionDelay ?? 0) ||
          !selectorMatches(selector, '[data-testid="accounts-profile-button"]')
          ? null
          : input
      if (selector === site.inputSelector && selectorMatches(selector, '#prompt-textarea'))
        return input
      if (
        selector === site.submitSelector &&
        selectorMatches(selector, '[data-testid="send-button"]')
      )
        return button
      return null
    },
    querySelectorAll(selector: string) {
      if (selector === 'button, a')
        return options.loggedOut
          ? [{ innerText: 'Log in', getBoundingClientRect: () => ({ width: 100, height: 30 }) }]
          : []
      if (selector === site.inputSelector && selectorMatches(selector, '#prompt-textarea'))
        return [input]
      if (
        selector === site.submitSelector &&
        selectorMatches(selector, '[data-testid="send-button"]')
      )
        return [button]
      if (
        selector === site.answerSelector &&
        selectorMatches(selector, '[data-message-author-role="assistant"] .markdown')
      )
        return sent ? [answer] : []
      return []
    },
  }
  const insert = async (value: string) => {
    inserted++
    if (options.acceptInput === false) return
    pendingInput = value
    if (!options.inputDelay) rawInput = value + '\u200b\u200c'
  }
  const send = () => {
    sends.push({ time, text: normalize(rawInput) })
    if (normalize(rawInput)) {
      sent++
      rawInput = ''
    }
  }
  const page = {
    goto: async () => {},
    url: async () => site.url,
    evaluate: async (fn: (...args: never[]) => unknown, arg: unknown) =>
      new Script(`(${fn.toString()})(arg)`).runInNewContext({ document: doc, arg }),
    mouse: {
      click: async (x: number) => {
        if (x > 300) send()
      },
    },
    keyboard: {
      press: async (key: string) => {
        if (key === 'Backspace') rawInput = ''
      },
      insertText: insert,
      paste: async ({ text }: { text: string }) => insert(text),
    },
    click: async () => {},
    fill: async (_selector: string, text: string) => insert(text),
    press: async () => {
      entered++
      send()
    },
    snapshot: async () => '',
  }
  await new Script(
    `(async () => {${buildEgoScript({ site, prompt, marker: '@@TEST@@' })}})()`,
  ).runInNewContext({
    taskSpace: async () => ({ page: () => page, finish: async () => {} }),
    Date: { now: () => time },
    setTimeout: (resolve: () => void, ms: number) => {
      time += ms
      if (pendingInput && time >= (options.inputDelay ?? 0)) {
        rawInput = pendingInput + '\u200b\u200c'
        pendingInput = ''
      }
      resolve()
    },
    console: {
      log: (value: string) => {
        output = value
      },
    },
  })
  return { answer: parseEgoOutput(output, '@@TEST@@'), sends, entered, inserted }
}

describe('web comparison input verification', () => {
  it('never submits an empty composer when the input operation was not accepted', async () => {
    const result = await runInput({ acceptInput: false })
    expect(result.answer).toEqual({ ok: false, reason: 'input-not-accepted' })
    expect(result.sends).toEqual([])
    expect(result.entered).toBe(0)
  })
  it('waits for the intended text and an enabled button, then submits exactly once', async () => {
    const result = await runInput({ inputDelay: 1200 })
    expect(result.answer).toEqual({ ok: true, text: 'Answer' })
    expect(result.sends).toHaveLength(1)
    expect(result.sends[0]?.text).toBe('A neutral test prompt')
    expect(result.sends[0]?.time).toBeGreaterThanOrEqual(1200)
    expect(result.entered).toBe(0)
  })
  it('does not fall back to Enter when the send control remains disabled', async () => {
    const result = await runInput({ enableSend: false })
    expect(result.answer).toEqual({ ok: false, reason: 'submit-not-ready' })
    expect(result.sends).toEqual([])
    expect(result.entered).toBe(0)
  })
  it('requires an existing ChatGPT login even when a guest composer is usable', async () => {
    const result = await runInput({ siteId: 'chatgpt', loggedOut: true })
    expect(result.inserted).toBe(0)
    expect(result.answer).toEqual({ ok: false, reason: 'login-wall' })
    expect(result.sends).toEqual([])
  })
  it('does not infer a ChatGPT login merely from missing login controls', async () => {
    const result = await runInput({ siteId: 'chatgpt', missingSession: true })
    expect(result.answer).toEqual({ ok: false, reason: 'login-wall' })
    expect(result.inserted).toBe(0)
    expect(result.sends).toEqual([])
  })
  it('waits for the signed-in account control after the composer appears', async () => {
    const result = await runInput({ siteId: 'chatgpt', sessionDelay: 1500 })
    expect(result.answer).toEqual({ ok: true, text: 'Answer' })
    expect(result.sends).toHaveLength(1)
    expect(result.sends[0]?.time).toBeGreaterThanOrEqual(1500)
  })
  it('never submits ChatGPT text that failed readback', async () => {
    const result = await runInput({ siteId: 'chatgpt', acceptInput: false })
    expect(result.answer).toEqual({ ok: false, reason: 'input-not-accepted' })
    expect(result.sends).toEqual([])
  })
  it('reads back ChatGPT input and clicks send exactly once', async () => {
    const result = await runInput({ siteId: 'chatgpt', inputDelay: 1200 })
    expect(result.answer).toEqual({ ok: true, text: 'Answer' })
    expect(result.sends).toHaveLength(1)
    expect(result.entered).toBe(0)
  })
  it('keeps selector and input failures distinct from a real site wall', () => {
    expect(isBlockReason('no-prompt-box')).toBe(false)
    expect(isBlockReason('input-not-accepted')).toBe(false)
    expect(isBlockReason('submit-not-ready')).toBe(false)
    expect(isBlockReason('blocked')).toBe(true)
    expect(isBlockReason('login-wall')).toBe(true)
  })
})
