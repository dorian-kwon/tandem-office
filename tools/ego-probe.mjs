#!/usr/bin/env node
// Manual probe for the AI compare feature (docs/superpowers/notes/manual-checks.md).
// Run it by hand on a machine where ego lite is installed and you are signed in to
// Gemini, Claude and Copilot inside it:
//
//   node tools/ego-probe.mjs [gemini|claude|copilot ...]
//
// For each site it opens the page in its own ego lite task space, waits for the
// page, prints how many elements each selector of apps/docs/src/shared/compare-sites.ts
// matches, and prints a snapshot (with refs) of the page. It never types or sends
// anything. Use the output to correct the site table, then set `verified: true`.
// No shell is used; the script text goes to `ego-browser nodejs` on stdin.
import { execFile, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const tablePath = join(here, '..', 'apps', 'docs', 'src', 'shared', 'compare-sites.ts')

/** reads the id/url/selector fields out of the table file (plain data, one object per site) */
function readSites() {
  const text = readFileSync(tablePath, 'utf8')
  const sites = []
  for (const block of text.split(/\n {2}\{\n/).slice(1)) {
    const field = (name, indent = 4) =>
      new RegExp(
        `\\n {${indent}}${name}:\\s+('(?:[^'\\\\]|\\\\.)*'|"(?:[^"\\\\]|\\\\.)*"|\\d[\\d_]*),`,
      ).exec('\n' + block)?.[1]
    const str = (name, indent = 4) => {
      const raw = field(name, indent)
      return raw ? raw.slice(1, -1).replace(/\\'/g, "'") : ''
    }
    const id = str('id')
    if (!id) continue
    sites.push({
      id,
      name: str('name'),
      url: str('url'),
      selectors: {
        input: str('inputSelector'),
        send: str('submitSelector'),
        busy: str('busySelector'),
        answer: str('answerSelector'),
        sidebarLink: str('reopenLinkSelector'),
        prepareOpen: str('open', 8),
        prepareItems: str('items', 8),
      },
      readStrategy: str('readStrategy'),
      loadTimeoutMs: Number((field('loadTimeoutMs') ?? '30000').replace(/_/g, '')),
    })
  }
  return sites
}

function findEgo() {
  const names =
    process.platform === 'win32' ? ['ego-browser.exe', 'ego-browser.cmd'] : ['ego-browser']
  const dirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
  dirs.push(join(homedir(), '.local', 'bin'))
  return { dirs, names }
}

function probeScript(site) {
  const job = JSON.stringify(JSON.stringify(site))
  return `const SITE = JSON.parse(${job});
const task = await taskSpace('tandem compare probe ' + SITE.id);
const page = task.page('p1');
await page.goto(SITE.url);
try { await page.waitForSelector(SITE.selectors.input, { state: 'visible', timeout: SITE.loadTimeoutMs }); }
catch (e) { console.log('input selector did not show up: ' + SITE.selectors.input); }
const counts = await page.evaluate((s) => Object.fromEntries(Object.entries(s).map(([k, v]) => {
  try { return [k, v ? document.querySelectorAll(v).length : 'n/a']; } catch (e) { return [k, 'bad selector']; }
})), SITE.selectors);
console.log('read strategy: ' + SITE.readStrategy);
console.log('selector matches (input, send, busy, answer, sidebarLink, prepareOpen, prepareItems; busy, answer and the menu items may legitimately be 0 before a prompt or before the menu opens):');
console.log(JSON.stringify(counts));
console.log(await page.snapshot());
await task.finish({ keep: [] });
`
}

const wanted = process.argv.slice(2)
const sites = readSites().filter((s) => wanted.length === 0 || wanted.includes(s.id))
const { dirs, names } = findEgo()

function resolveEgo() {
  return new Promise((resolve) => {
    const candidates = dirs.flatMap((d) => names.map((n) => join(d, n)))
    const next = () => {
      const c = candidates.shift()
      if (!c) return resolve(null)
      execFile(c, ['--version'], { timeout: 5000, windowsHide: true }, (err) =>
        err ? next() : resolve(c),
      )
    }
    next()
  })
}

const ego = await resolveEgo()
if (!ego) {
  console.error(
    'ego-browser was not found. Install ego lite first: https://github.com/citrolabs/ego-lite',
  )
  process.exit(1)
}
for (const site of sites) {
  console.log(`\n===== ${site.name} (${site.url}) =====`)
  await new Promise((resolve) => {
    const child = spawn(ego, ['nodejs'], {
      stdio: ['pipe', 'inherit', 'inherit'],
      shell: false,
      windowsHide: true,
    })
    child.on('close', resolve)
    child.on('error', (e) => {
      console.error(String(e))
      resolve()
    })
    child.stdin.end(probeScript(site))
  })
}
