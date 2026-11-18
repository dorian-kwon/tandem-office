import { describe, expect, it } from 'vitest'
import { crashLine } from '../src/main/crash-log'
import {
  RENDERER_ERROR_HOOK,
  RENDERER_ERROR_TAG,
  createErrorLimiter,
  rendererErrorEntry,
} from '../src/main/renderer-errors'

/**
 * A renderer error that leaves the process alive (React unmounting a whole editor on
 * "Minified React error #185") used to leave no trace. The page reports it on the console
 * with a tag; the main process turns that line into a crash entry holding the error's class
 * name, its React number and the function and bundle file of its top frames, and nothing of
 * the message, which can quote the document.
 */

function line(payload: { n?: string; m?: string; s?: string }): string {
  return RENDERER_ERROR_TAG + JSON.stringify(payload)
}

const REACT_STACK = [
  'Error: Minified React error #185; visit https://react.dev/errors/185 for the full message',
  '    at Ke (file:///C:/Users/someone/AppData/Local/Programs/tandem%20office/resources/modules/docs/assets/index-Dk3f9a.js:12:3456)',
  '    at https://host/assets/vendor-AbC.js?v=3#x:7:80',
  '    at async Object.run [as go] (file:///C:/Users/someone/resources/modules/docs/assets/index-Dk3f9a.js:99:1)',
].join('\n')

describe('rendererErrorEntry', () => {
  it('turns a tagged console line into an entry with the class, React number and frames', () => {
    const entry = rendererErrorEntry(
      line({ n: 'Error', m: 'Minified React error #185; visit', s: REACT_STACK }),
      'docs',
    )
    expect(entry).toEqual({
      kind: 'renderer-error',
      reason: 'Error',
      editor: 'docs',
      code: '185',
      frames: [
        'Ke@index-Dk3f9a.js:12:3456',
        '@vendor-AbC.js:7:80',
        'Object.run@index-Dk3f9a.js:99:1',
      ],
    })
  })

  it('is null for a console line that is not the tagged report', () => {
    expect(rendererErrorEntry('Uncaught Error: Minified React error #185', 'docs')).toBeNull()
    expect(rendererErrorEntry(`${RENDERER_ERROR_TAG}not json`, 'docs')).toBeNull()
    expect(rendererErrorEntry(`${RENDERER_ERROR_TAG}42`, 'docs')).toBeNull()
  })

  it('never lets the message, a path or a file name into the written line', () => {
    const entry = rendererErrorEntry(
      line({
        n: 'TypeError',
        m: 'Cannot read properties of undefined (reading "salary") in C:\\Users\\someone\\plan.docx',
        s:
          'TypeError: Cannot read properties of undefined\n' +
          '    at renderRow (C:\\Users\\someone\\Documents\\salary.xlsx:1:2)\n' +
          '    at f (file:///home/someone/index-abc.js:5:6)',
      }),
      'sheets',
    )
    const written = crashLine(entry!, new Date('2026-11-18T01:02:03.000Z'))
    expect(written).not.toMatch(/someone|salary|plan\.docx|Cannot read|C:\\/)
    expect(JSON.parse(written)).toMatchObject({
      kind: 'renderer-error',
      reason: 'TypeError',
      editor: 'sheets',
      frames: ['f@index-abc.js:5:6'],
    })
  })

  it('names an error with no usable class "Error" and a React number only from the React text', () => {
    expect(rendererErrorEntry(line({ n: 'not a word!', m: 'x' }), 'home')).toMatchObject({
      reason: 'Error',
    })
    expect(
      rendererErrorEntry(line({ n: 'Error', m: 'see error #999 in my document' }), 'home'),
    ).not.toHaveProperty('code')
  })

  it('keeps the first six frames that name a script', () => {
    const lots = Array.from(
      { length: 12 },
      (_, i) => `    at f${i} (https://h/a/index.js:${i + 1}:1)`,
    )
    const entry = rendererErrorEntry(
      line({ n: 'Error', s: ['Error: x', ...lots].join('\n') }),
      'docs',
    )
    expect(entry?.frames).toHaveLength(6)
    expect(entry?.frames?.[0]).toBe('f0@index.js:1:1')
  })
})

describe('createErrorLimiter', () => {
  const entry = {
    kind: 'renderer-error',
    reason: 'Error',
    code: '185',
    frames: ['Ke@index.js:1:2'],
  } as const

  it('lets the same error through once a minute', () => {
    let at = 0
    const allow = createErrorLimiter({ now: () => at })
    expect(allow(entry)).toBe(true)
    at += 10_000
    expect(allow(entry)).toBe(false)
    at += 51_000
    expect(allow(entry)).toBe(true)
  })

  it('treats a different error as its own', () => {
    const allow = createErrorLimiter({ now: () => 0 })
    expect(allow(entry)).toBe(true)
    expect(allow({ ...entry, frames: ['Other@index.js:9:9'] })).toBe(true)
    expect(allow({ ...entry, code: '310' })).toBe(true)
  })

  it('stops after a run of distinct errors, so a render loop cannot fill the log', () => {
    const allow = createErrorLimiter({ now: () => 0, maxPerRun: 3 })
    expect(allow({ ...entry, code: '1' })).toBe(true)
    expect(allow({ ...entry, code: '2' })).toBe(true)
    expect(allow({ ...entry, code: '3' })).toBe(true)
    expect(allow({ ...entry, code: '4' })).toBe(false)
  })
})

describe('the script put in a page', () => {
  function install(): {
    listeners: Map<string, (event: unknown) => void>
    logged: string[]
    run: () => void
  } {
    const listeners = new Map<string, (event: unknown) => void>()
    const logged: string[] = []
    const window = {
      addEventListener: (type: string, fn: (event: unknown) => void) =>
        void listeners.set(type, fn),
    } as Record<string, unknown>
    const console = { error: (text: string) => void logged.push(text) }
    return {
      listeners,
      logged,
      run: () => new Function('window', 'console', RENDERER_ERROR_HOOK)(window, console),
    }
  }

  it('reports an uncaught error on the console with the tag', () => {
    const page = install()
    page.run()
    const error = Object.assign(new Error('Minified React error #185'), { name: 'Error' })
    page.listeners.get('error')?.({ error, message: 'Uncaught Error: Minified React error #185' })
    expect(page.logged).toHaveLength(1)
    expect(page.logged[0]!.startsWith(RENDERER_ERROR_TAG)).toBe(true)
    const payload = JSON.parse(page.logged[0]!.slice(RENDERER_ERROR_TAG.length)) as Record<
      string,
      string
    >
    expect(payload.n).toBe('Error')
    expect(payload.m).toContain('React error #185')
    expect(payload.s).toContain('Error')
  })

  it('reports an unhandled promise rejection too', () => {
    const page = install()
    page.run()
    page.listeners.get('unhandledrejection')?.({ reason: new TypeError('boom') })
    expect(JSON.parse(page.logged[0]!.slice(RENDERER_ERROR_TAG.length))).toMatchObject({
      n: 'TypeError',
    })
  })

  it('copes with something thrown that is not an error', () => {
    const page = install()
    page.run()
    page.listeners.get('unhandledrejection')?.({ reason: 'just a string' })
    page.listeners.get('error')?.({ error: null, message: 'ResizeObserver loop' })
    expect(page.logged).toHaveLength(2)
  })

  it('installs once per page', () => {
    const listeners = new Map<string, () => void>()
    let added = 0
    const window: Record<string, unknown> = {
      addEventListener: (type: string, fn: () => void) => {
        added += 1
        listeners.set(type, fn)
      },
    }
    const run = (): unknown =>
      new Function('window', 'console', RENDERER_ERROR_HOOK)(window, { error() {} })
    run()
    run()
    expect(added).toBe(2)
  })
})
