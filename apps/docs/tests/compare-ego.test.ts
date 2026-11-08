import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { Script } from 'node:vm'
import { COMPARE_SITES } from '../src/shared/compare-sites'
import { buildEgoScript, jsonStringLiteral, parseEgoOutput } from '../src/main/compare/ego-script'
import { detectEgo, egoCandidates } from '../src/main/compare/ego-detect'
import {
  EGO_OUTPUT_CAP,
  createEgoDriver,
  egoChildEnv,
  type EgoChild,
} from '../src/main/compare/ego-driver'
import { readCompareConsent, writeCompareConsent } from '../src/main/compare/consent-store'
import { translationSourceCopy } from '../src/main/compare/source-path'

const site = COMPARE_SITES[0]!

describe('ego script generator', () => {
  const nasty = 'He said "go"; process.exit(1)\n`${evil}` \\ \u2028 end\nsecond line'
  const script = buildEgoScript({ site, prompt: nasty, marker: '@@M@@' })

  it('is syntactically valid JavaScript (top-level await wrapped for the check)', () => {
    expect(() => new Script(`(async () => {\n${script}\n})`)).not.toThrow()
  })

  it('carries the prompt as JSON data in one string literal, never as code', () => {
    const literal = /^const JOB = JSON\.parse\((.*)\);\n/.exec(script)![1]!
    const job = JSON.parse(new Script(literal).runInNewContext({}) as string) as {
      prompt: string
      marker: string
      site: { id: string }
    }
    expect(job.prompt).toBe(nasty)
    expect(job.marker).toBe('@@M@@')
    expect(job.site.id).toBe('gemini')
    // the raw text appears nowhere outside the escaped literal
    expect(script.replace(literal, '').includes('process.exit(1)')).toBe(false)
    expect(script.includes('\u2028')).toBe(false)
  })

  it('uses only the documented ego-browser API, no raw CDP, no environment, no shell', () => {
    for (const call of [
      "taskSpace('tandem compare '",
      "task.page('p1')",
      'page.goto(',
      'page.url()',
      'page.waitForFunction(',
      'page.evaluate(',
      'page.keyboard.insertText(',
      "page.press(SITE.inputSelector, 'Enter')",
      'task.finish({ keep: [] })',
    ])
      expect(script).toContain(call)
    expect(script).not.toMatch(
      /sendCDPMessage|page\.cdp|process\.env|require\(|child_process|import\(/,
    )
  })

  it('the per-site selectors travel as data in the job, not in the code', () => {
    const literal = /^const JOB = JSON\.parse\((.*)\);\n/.exec(script)![1]!
    const job = JSON.parse(new Script(literal).runInNewContext({}) as string) as {
      site: typeof site
    }
    expect(job.site.inputSelector).toBe(site.inputSelector)
    expect(job.site.answerSelector).toBe(site.answerSelector)
    expect(script.replace(literal, '')).not.toContain(site.answerSelector)
  })

  it('checks the address, a covering wall and the prompt box before typing, and maps a hand-over to needs-user', () => {
    expect(script).toContain('loggedOutUrl')
    expect(script).toContain('elementFromPoint')
    expect(script).toContain('LOGIN_WALL')
    expect(script).toContain('NO_PROMPT_BOX')
    expect(script).toContain('NEEDS_USER')
    // typing happens only after the box proved usable
    expect(script.indexOf("boxState === 'ok'")).toBeLessThan(script.indexOf('keyboard.insertText'))
    // never retries around a hand-over: no finish() and no second attempt in the catch
    const handover = script.slice(script.indexOf('const handedOver'))
    expect(handover).not.toContain('finish(')
  })

  it('jsonStringLiteral round-trips', () => {
    expect(JSON.parse(JSON.parse(jsonStringLiteral({ a: '\u2029"x' })))).toEqual({ a: '\u2029"x' })
  })
})

describe('ego output parsing', () => {
  it('takes the last marker line and ignores look-alikes', () => {
    const out = [
      'noise',
      '@@M@@ {"ok":false,"reason":"old"}',
      'text mentioning @@M@@ {"ok":true,"text":"fake"}',
      '@@M@@ {"ok":true,"text":"page text"}',
    ].join('\n')
    expect(parseEgoOutput(out, '@@M@@')).toEqual({ ok: true, text: 'page text' })
    expect(parseEgoOutput('@@M@@ {"ok":false,"reason":"nope"}\n', '@@M@@')).toEqual({
      ok: false,
      reason: 'nope',
    })
  })
  it('reports missing and unreadable results', () => {
    expect(parseEgoOutput('hello', '@@M@@')).toMatchObject({ ok: false })
    expect(parseEgoOutput('@@M@@ {not json', '@@M@@')).toMatchObject({ ok: false })
    expect(parseEgoOutput('@@M@@ {"ok":true}', '@@M@@')).toMatchObject({ ok: false })
  })
})

describe('ego detection', () => {
  it('searches the PATH first, then the standard places of the platform', () => {
    const mac = egoCandidates('darwin', { PATH: '/opt/x:/usr/bin' }, '/Users/me')
    expect(mac.slice(0, 3)).toEqual([
      '/opt/x/ego-browser',
      '/usr/bin/ego-browser',
      '/Users/me/.local/bin/ego-browser',
    ])
    expect(mac.some((p) => p.startsWith('/Applications/'))).toBe(true)
    expect(mac.some((p) => p.startsWith('/Users/me/Applications/'))).toBe(true)
    const win = egoCandidates(
      'win32',
      {
        PATH: 'C:\\bin',
        LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
        ProgramFiles: 'C:\\Program Files',
      },
      'C:\\Users\\me',
    )
    expect(win[0]).toBe('C:\\bin\\ego-browser.exe')
    expect(win).toContain('C:\\Users\\me\\.local\\bin\\ego-browser.exe')
    expect(win.some((p) => p.startsWith('C:\\Users\\me\\AppData\\Local\\'))).toBe(true)
    expect(win.some((p) => p.startsWith('C:\\Program Files\\'))).toBe(true)
    expect(new Set(mac).size).toBe(mac.length)
  })

  it('counts a candidate only when it exists and answers --version', async () => {
    const files = new Set([
      '/usr/local/bin/ego-browser',
      '/Applications/Ego.app/Contents/MacOS/ego-browser',
    ])
    const ran: string[] = []
    const found = await detectEgo({
      platform: 'darwin',
      env: { PATH: '' },
      homeDir: '/Users/me',
      exists: async (p) => files.has(p),
      runsVersion: async (p) => {
        ran.push(p)
        return p.startsWith('/Applications')
      },
    })
    expect(found).toEqual({
      installed: true,
      path: '/Applications/Ego.app/Contents/MacOS/ego-browser',
    })
    expect(ran).toEqual(
      ['/Applications/Ego.app/Contents/MacOS/ego-browser', '/usr/local/bin/ego-browser'].filter(
        (p) => ran.includes(p),
      ),
    )
    expect(
      await detectEgo({
        platform: 'darwin',
        env: {},
        homeDir: '/h',
        exists: async () => false,
        runsVersion: async () => true,
      }),
    ).toEqual({ installed: false })
    expect(
      await detectEgo({
        platform: 'linux',
        env: { PATH: '/a' },
        homeDir: '/h',
        exists: async () => {
          throw new Error('boom')
        },
        runsVersion: async () => true,
      }),
    ).toEqual({ installed: false })
  })
})

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & EgoChild & { written: string; ended: boolean }
  const out = new EventEmitter()
  const err = new EventEmitter()
  child.written = ''
  child.ended = false
  Object.assign(child, {
    pid: 4242,
    stdin: Object.assign(new EventEmitter(), {
      write: (d: string) => (child.written += d),
      end: () => (child.ended = true),
    }),
    stdout: out,
    stderr: err,
  })
  return { child, out, err }
}

describe('ego driver', () => {
  const installed = async () => ({ installed: true, path: '/bin/ego-browser' })
  const base = (spawned: ReturnType<typeof fakeChild>, killed: EgoChild[] = []) => ({
    detect: installed,
    spawn: (_c: string, _a: string[], _e: NodeJS.ProcessEnv) => spawned.child,
    killTree: (c: EgoChild) => void killed.push(c),
    env: { PATH: '/bin', ANTHROPIC_API_KEY: 'secret', OPENAI_API_KEY: 's2', HOME: '/h' },
    platform: 'darwin' as const,
    nonce: () => 'N1',
  })
  const marker = '@@TANDEM_COMPARE_N1@@'

  it('starts `ego-browser nodejs` without a shell, feeds the script on stdin and returns the extracted answer', async () => {
    const f = fakeChild()
    let spawnArgs: unknown[] = []
    const driver = createEgoDriver({
      ...base(f),
      spawn: (c, a, e) => {
        spawnArgs = [c, a, e]
        return f.child
      },
    })
    const prompt = 'instruction'
    const pending = driver.ask(site, prompt, new AbortController().signal)
    await Promise.resolve()
    await Promise.resolve()
    expect(spawnArgs[0]).toBe('/bin/ego-browser')
    expect(spawnArgs[1]).toEqual(['nodejs'])
    const env = spawnArgs[2] as NodeJS.ProcessEnv
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.HOME).toBe('/h')
    expect(f.child.written).toContain(marker)
    expect(f.child.ended).toBe(true)
    f.out.emit('data', `${marker} ${JSON.stringify({ ok: true, text: 'The final text' })}\n`)
    f.child.emit('close', 0)
    expect(await pending).toEqual({ ok: true, text: 'The final text' })
  })

  it('reports failures with a reason: script failure, no result, spawn error', async () => {
    const f1 = fakeChild()
    const d1 = createEgoDriver(base(f1))
    const p1 = d1.ask(site, 'p', new AbortController().signal)
    await Promise.resolve()
    await Promise.resolve()
    f1.out.emit('data', `${marker} {"ok":false,"reason":"not signed in"}\n`)
    f1.child.emit('close', 0)
    expect(await p1).toEqual({ ok: false, reason: 'not signed in' })

    const f2 = fakeChild()
    const p2 = createEgoDriver(base(f2)).ask(site, 'p', new AbortController().signal)
    await Promise.resolve()
    await Promise.resolve()
    f2.err.emit('data', 'ego is not running\nmore')
    f2.child.emit('close', 1)
    expect(await p2).toEqual({
      ok: false,
      reason: 'the ego browser returned no result: ego is not running',
    })

    const bad = createEgoDriver({
      ...base(fakeChild()),
      spawn: () => {
        throw new Error('ENOENT')
      },
    })
    expect(await bad.ask(site, 'p', new AbortController().signal)).toMatchObject({ ok: false })

    const missing = createEgoDriver({
      ...base(fakeChild()),
      detect: async () => ({ installed: false }),
    })
    expect(await missing.ask(site, 'p', new AbortController().signal)).toEqual({
      ok: false,
      reason: 'ego browser is not installed',
    })
  })

  it('passes the skip and needs-user codes through untouched, and reads ego-browser own hand-over exit', async () => {
    for (const reason of ['login-wall', 'no-prompt-box', 'needs-user']) {
      const f = fakeChild()
      const p = createEgoDriver(base(f)).ask(site, 'p', new AbortController().signal)
      await Promise.resolve()
      await Promise.resolve()
      f.out.emit('data', `${marker} ${JSON.stringify({ ok: false, reason })}\n`)
      f.child.emit('close', 0)
      expect(await p).toEqual({ ok: false, reason })
    }
    const f = fakeChild()
    const p = createEgoDriver(base(f)).ask(site, 'p', new AbortController().signal)
    await Promise.resolve()
    await Promise.resolve()
    f.err.emit('data', 'Error: The user now controls this task space')
    f.child.emit('close', 1)
    expect(await p).toEqual({ ok: false, reason: 'needs-user' })
  })

  it('abort kills the process tree and answers stopped; an already aborted signal never spawns', async () => {
    const f = fakeChild()
    const killed: EgoChild[] = []
    const controller = new AbortController()
    const p = createEgoDriver(base(f, killed)).ask(site, 'p', controller.signal)
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    expect(await p).toEqual({ ok: false, reason: 'stopped' })
    expect(killed).toEqual([f.child])
    let spawned = 0
    const done = new AbortController()
    done.abort()
    const d = createEgoDriver({ ...base(fakeChild()), spawn: () => (spawned++, f.child) })
    expect(await d.ask(site, 'p', done.signal)).toEqual({ ok: false, reason: 'stopped' })
    expect(spawned).toBe(0)
  })

  it('has a hard timeout that kills the tree', async () => {
    const f = fakeChild()
    const killed: EgoChild[] = []
    const quick = { ...site, loadTimeoutMs: 5, answerTimeoutMs: 5 }
    const p = createEgoDriver({ ...base(f, killed), graceMs: 5 }).ask(
      quick,
      'p',
      new AbortController().signal,
    )
    expect(await p).toEqual({ ok: false, reason: 'the ego browser took too long' })
    expect(killed).toEqual([f.child])
  })

  it('caps captured output but keeps the end, where the result line is', async () => {
    const f = fakeChild()
    const p = createEgoDriver(base(f)).ask(site, 'p', new AbortController().signal)
    await Promise.resolve()
    await Promise.resolve()
    f.out.emit('data', 'x'.repeat(EGO_OUTPUT_CAP + 5000))
    f.out.emit('data', `\n${marker} ${JSON.stringify({ ok: true, text: 'answer' })}\n`)
    f.child.emit('close', 0)
    expect(await p).toEqual({ ok: true, text: 'answer' })
  })

  it('environment is an allow-list', () => {
    expect(
      egoChildEnv(
        { PATH: '/b', HOME: '/h', GITHUB_TOKEN: 't', CLAUDE_CODE_OAUTH_TOKEN: 'c', Path: 'p' },
        'linux',
      ),
    ).toEqual({ PATH: '/b', HOME: '/h' })
    expect(egoChildEnv({ Path: 'C:\\x', Secret: 's' }, 'win32')).toEqual({ Path: 'C:\\x' })
  })
})

describe('consent and source copy', () => {
  it('consent is remembered once written and ignored when unreadable or from another version', async () => {
    let stored: string | null = null
    const fs = { read: async () => stored, write: async (t: string) => void (stored = t) }
    expect(await readCompareConsent(fs)).toBe(false)
    await writeCompareConsent(fs)
    expect(await readCompareConsent(fs)).toBe(true)
    stored = '{"consentVersion":0}'
    expect(await readCompareConsent(fs)).toBe(false)
    stored = 'garbage'
    expect(await readCompareConsent(fs)).toBe(false)
  })

  it('finds the source copy only inside a translation project', async () => {
    const files = new Set(['/p/.tandem/project.json', '/p/source/a.docx'])
    const ex = async (p: string) => files.has(p)
    expect(await translationSourceCopy('/p/output/a.docx', 'linux', ex)).toBe('/p/source/a.docx')
    expect(await translationSourceCopy('/p/output/b.docx', 'linux', ex)).toBeNull()
    expect(await translationSourceCopy('/p/other/a.docx', 'linux', ex)).toBeNull()
    expect(await translationSourceCopy('/q/output/a.docx', 'linux', ex)).toBeNull()
    expect(await translationSourceCopy('/p/output/a.odt', 'linux', ex)).toBeNull()
    expect(await translationSourceCopy('output/a.docx', 'linux', ex)).toBeNull()
    const win = new Set(['C:\\p\\.tandem\\project.json', 'C:\\p\\source\\a.docx'])
    expect(
      await translationSourceCopy('C:\\p\\output\\a.docx', 'win32', async (x) => win.has(x)),
    ).toBe('C:\\p\\source\\a.docx')
  })
})
