/**
 * The script that runs inside ego lite (`ego-browser nodejs`, read from stdin)
 * to put one prompt into one AI website and bring the answer back, plus the
 * parsing of what it prints. Everything here is pure: the script is built as a
 * string and unit-tested as a string, because ego lite itself cannot run in
 * tests.
 *
 * The script does not inherit the environment or the working directory, so the
 * prompt and the site entry travel INSIDE it as data: one JSON document, written
 * as a string literal that the script parses (`JSON.parse`), never pasted into code.
 * It uses only the documented ego-browser scripting API (ego-browser skill guide
 * v2.2.0: taskSpace, page.goto/click/fill/press/keyboard/waitForSelector/
 * waitForFunction/evaluate/snapshot, task.finish).
 *
 * Flow (a failing step ends in a `{ok:false, reason}` result line):
 *  1. resume or create this site's Task Space ("tandem compare <id>"), page p1, goto the site
 *  2. wait for a usable prompt box, watching the address: a redirect to a login page, a CAPTCHA
 *     or "unusual traffic" page, a wall covering the box, or no box ends the run as a blocked
 *     engine (nothing is clicked to get past a wall). A guest session with a working box proceeds
 *  3. count the assistant messages, click the input, insert the prompt
 *  4. submit (Enter in the input, or click the send button)
 *  5. wait until a new assistant message exists and the stop button is gone
 *  6. wait until the last message's text stayed the same for `settleMs`
 *  7. read the last message's text with page.evaluate, print one marker line,
 *     `task.finish({ keep: [] })` (not on failure: the space stays for the person to look at)
 */
import {
  COMPARE_BLOCKED,
  COMPARE_LOGIN_WALL,
  COMPARE_NEEDS_USER,
  COMPARE_NO_PROMPT_BOX,
} from '../../shared/compare'
import type { CompareSite } from '../../shared/compare-sites'

export interface EgoJob {
  site: CompareSite
  prompt: string
  /** unique per run: the one output line that carries the result starts with it */
  marker: string
}

/** a JS string literal holding `value` as JSON text; safe to place in source code */
export function jsonStringLiteral(value: unknown): string {
  // U+2028 and U+2029 are legal inside JSON strings but were line breaks in older JS engines
  return JSON.stringify(JSON.stringify(value))
    .split(String.fromCharCode(0x2028))
    .join('\\u2028')
    .split(String.fromCharCode(0x2029))
    .join('\\u2029')
}

const BODY = String.raw`
const SITE = JOB.site;
const report = (result) => console.log(JOB.marker + ' ' + JSON.stringify(result));
const LOGIN_WALL = JOB.codes.loginWall;
const NO_PROMPT_BOX = JOB.codes.noPromptBox;
const NEEDS_USER = JOB.codes.needsUser;
const BLOCKED = JOB.codes.blocked;
// CAPTCHA and "unusual traffic" pages: the engine is blocked, nothing is clicked to get past them
const WALL_URL = /google\.com\/sorry|\/captcha|\/challenge|recaptcha|hcaptcha|turnstile/i;
const WALL_TEXT = /unusual traffic|automated quer|captcha|verify you are (a )?human|are you a robot|자동화된 쿼리|비정상적인 트래픽|로봇이 아닙니다|사람인지 확인/i;
const wallText = () => WALL_TEXT.test(String(document.body ? document.body.innerText : '').slice(0, 4000));
const inputState = (selector) => {
  const el = document.querySelector(selector);
  if (!el) return 'none';
  const box = el.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return 'none';
  const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  if (top && (top === el || el.contains(top) || top.contains(el))) return 'ok';
  // something else is on top of the box: a cookie or consent notice only the person should
  // answer, or a login wall
  const layer = top ? top.closest('[role="dialog"], [aria-modal="true"], dialog') : null;
  const words = String((layer || top || document.body).innerText || '').slice(0, 600);
  return /cookie|쿠키|consent|동의|privacy|개인정보/i.test(words) ? 'consent' : 'covered';
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// the text still sitting in the (visible) prompt box: empty after a message was sent
const boxText = (selector) => {
  const box = [...document.querySelectorAll(selector)].find((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  return box ? String(box.innerText || box.textContent || '').trim() : '';
};
// the centre of the first visible, enabled match of a selector (list): where a real mouse click goes
const rectOf = (selector) => {
  const el = [...document.querySelectorAll(selector)].find((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !n.disabled && n.getAttribute('aria-disabled') !== 'true'; });
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
};
const pageState = (arg) => {
  const answers = document.querySelectorAll(arg.answer);
  const last = answers.length > 0 ? answers[answers.length - 1] : null;
  return {
    count: answers.length,
    busy: arg.busy ? document.querySelector(arg.busy) !== null : false,
    text: last ? String(last.innerText || last.textContent || '') : '',
  };
};
async function main() {
  const task = await taskSpace('tandem compare ' + SITE.id);
  const page = task.page('p1');
  await page.goto(SITE.url);
  const loggedOutUrl = SITE.loggedOutUrl ? new RegExp(SITE.loggedOutUrl, 'i') : null;
  const start = Date.now();
  let boxState = 'none';
  while (Date.now() - start < SITE.loadTimeoutMs) {
    const here = String(await page.url());
    if (WALL_URL.test(here)) return { ok: false, reason: BLOCKED };
    if (loggedOutUrl && loggedOutUrl.test(here)) return { ok: false, reason: LOGIN_WALL };
    boxState = await page.evaluate(inputState, SITE.inputSelector);
    if (boxState === 'ok') break;
    await sleep(500);
  }
  // a cookie or consent notice is the person's choice, never clicked for them
  if (boxState === 'consent') return { ok: false, reason: NEEDS_USER };
  if (boxState !== 'ok' && (await page.evaluate(wallText))) return { ok: false, reason: BLOCKED };
  if (boxState === 'covered') return { ok: false, reason: LOGIN_WALL };
  if (boxState !== 'ok') {
    const shot = await page.snapshot();
    const text = typeof shot === 'string' ? shot : JSON.stringify(shot);
    const wall = SITE.loginHint && new RegExp(SITE.loginHint, 'i').test(text);
    return { ok: false, reason: wall ? LOGIN_WALL : NO_PROMPT_BOX };
  }
  const arg = { answer: SITE.answerSelector, busy: SITE.busySelector };
  const before = (await page.evaluate(pageState, arg)).count;
  // Input goes in the way a person does it, in the agent space: a real mouse click into the box,
  // the box emptied (a site may restore an old draft), the text, then a real click on the send
  // button. Several sites only start the request for a real click, not for a key press alone.
  if (SITE.inputMode === 'fill') {
    await page.fill(SITE.inputSelector, JOB.prompt);
  } else {
    const boxAt = await page.evaluate(rectOf, SITE.inputSelector);
    if (boxAt) await page.mouse.click(boxAt.x, boxAt.y, { label: 'focus prompt box' });
    else await page.click(SITE.inputSelector);
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');
    if (SITE.inputMode === 'paste') await page.keyboard.paste({ text: JOB.prompt });
    else await page.keyboard.insertText(JOB.prompt);
  }
  // an editor needs a moment to take the typed text into its state before it can send it
  await sleep(700);
  const sendByButton = async () => {
    const at = SITE.submitSelector ? await page.evaluate(rectOf, SITE.submitSelector) : null;
    if (!at) return false;
    await page.mouse.click(at.x, at.y, { label: 'send message' });
    return true;
  };
  if (SITE.submit === 'enter') await page.press(SITE.inputSelector, 'Enter');
  else if (!(await sendByButton())) await page.press(SITE.inputSelector, 'Enter');
  // the text is still in the box: it was not sent, so try the other way
  await sleep(1500);
  if ((await page.evaluate(boxText, SITE.inputSelector)) !== '') {
    if (SITE.submit === 'enter') await sendByButton();
    else await page.press(SITE.inputSelector, 'Enter');
  }
  // poll (a page that is still navigating after the send answers evaluate with an error for a moment)
  const waitEnd = Date.now() + SITE.answerTimeoutMs;
  let lastError = '';
  let answered = false;
  while (Date.now() < waitEnd) {
    try {
      const now = await page.evaluate(pageState, arg);
      if (now.count > before && !now.busy) { answered = true; break; }
      if (WALL_URL.test(String(await page.url()))) return { ok: false, reason: BLOCKED };
    } catch (error) {
      lastError = String((error && error.message) || error).slice(0, 160);
    }
    await sleep(1000);
  }
  if (!answered) {
    let wall = false;
    try { wall = await page.evaluate(wallText); } catch (error) { /* keep the timeout */ }
    return { ok: false, reason: wall ? BLOCKED : lastError || 'timeout' };
  }
  const end = Date.now() + SITE.answerTimeoutMs;
  let state = await page.evaluate(pageState, arg);
  while (Date.now() < end) {
    await sleep(SITE.settleMs);
    let next;
    try { next = await page.evaluate(pageState, arg); } catch (error) { continue; }
    const settled = !next.busy && next.text === state.text && next.text.trim() !== '';
    state = next;
    if (settled) {
      await task.finish({ keep: [] });
      return { ok: true, text: state.text };
    }
  }
  return { ok: false, reason: 'timeout' };
}
let outcome;
try {
  outcome = await main();
} catch (error) {
  const message = String((error && error.message) || error);
  // ego lite hands the space to the person when a site raises a browser prompt (notifications, ...)
  const handedOver = /user (now )?control|USER_IN_CONTROL|handed off/i.test(message);
  outcome = { ok: false, reason: handedOver ? NEEDS_USER : message.slice(0, 300) };
}
report(outcome);
`

/** the program text for one site and one prompt */
export function buildEgoScript(job: EgoJob): string {
  const data = {
    ...job,
    codes: {
      loginWall: COMPARE_LOGIN_WALL,
      noPromptBox: COMPARE_NO_PROMPT_BOX,
      needsUser: COMPARE_NEEDS_USER,
      blocked: COMPARE_BLOCKED,
    },
  }
  return `const JOB = JSON.parse(${jsonStringLiteral(data)});\n${BODY}`
}

/** what the script reported, from everything the process printed */
export type EgoOutcome = { ok: true; text: string } | { ok: false; reason: string }

/**
 * The result of one run from its output: the last line that starts with the run's
 * marker. Lines that merely mention the marker elsewhere do not count.
 */
export function parseEgoOutput(output: string, marker: string): EgoOutcome {
  const lines = output.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!line.startsWith(`${marker} `)) continue
    try {
      const value = JSON.parse(line.slice(marker.length + 1)) as unknown
      if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>
        if (record.ok === true && typeof record.text === 'string')
          return { ok: true, text: record.text }
        if (record.ok === false && typeof record.reason === 'string')
          return { ok: false, reason: record.reason }
      }
    } catch {
      /* fall through to the failure below */
    }
    return { ok: false, reason: 'the ego browser returned an unreadable result' }
  }
  return { ok: false, reason: 'the ego browser returned no result' }
}
