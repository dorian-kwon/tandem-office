import { describe, expect, it } from 'vitest'
import { crashLine } from '../src/main/crash-log'

/**
 * The detail a crash line may carry besides the basics: how long the app had run, how many
 * tabs of each editor were open, the last few actions as fixed words, and for a renderer
 * error its React number and the function and bundle file of its top frames. All of it is
 * identifier-like; a message, a path or a file name still never gets in.
 */

const AT = new Date('2026-11-18T01:02:03.000Z')

function parse(entry: Parameters<typeof crashLine>[0]): Record<string, unknown> {
  return JSON.parse(crashLine(entry, AT)) as Record<string, unknown>
}

describe('crash line detail', () => {
  it('writes uptime, tab counts, the action trail, the React number and the top frames', () => {
    const line = parse({
      kind: 'renderer-error',
      reason: 'Error',
      editor: 'docs',
      uptimeS: 3720,
      tabs: { docs: 2, sheets: 1 },
      trail: [
        { t: 1, a: 'app-start' },
        { t: 40, a: 'tab-open:docs' },
        { t: 3700, a: 'ai-start' },
      ],
      code: '185',
      frames: ['Ke@index-Dk3f9a.js:12:3456', '@vendor-AbC.js:1:20'],
    })
    expect(line).toMatchObject({
      kind: 'renderer-error',
      reason: 'Error',
      editor: 'docs',
      uptimeS: 3720,
      tabs: { docs: 2, sheets: 1 },
      trail: [
        { t: 1, a: 'app-start' },
        { t: 40, a: 'tab-open:docs' },
        { t: 3700, a: 'ai-start' },
      ],
      code: '185',
      frames: ['Ke@index-Dk3f9a.js:12:3456', '@vendor-AbC.js:1:20'],
    })
  })

  it('leaves the detail out when there is none', () => {
    expect(parse({ kind: 'renderer', reason: 'oom' })).toEqual({
      at: '2026-11-18T01:02:03.000Z',
      kind: 'renderer',
      reason: 'oom',
    })
  })

  it('drops uptime that is not a whole non-negative number', () => {
    expect(parse({ kind: 'renderer', uptimeS: -5 })).not.toHaveProperty('uptimeS')
    expect(parse({ kind: 'renderer', uptimeS: 1.5 })).not.toHaveProperty('uptimeS')
    expect(parse({ kind: 'renderer', uptimeS: 0 })).toMatchObject({ uptimeS: 0 })
  })

  it('keeps only identifier-like tab names with small whole counts', () => {
    const line = parse({
      kind: 'renderer',
      tabs: {
        docs: 3,
        'C:\\Users\\someone\\plan.docx': 1,
        'my secret.xlsx': 2,
        sheets: -1,
        slides: 1.5,
        pdf: 100000,
      },
    })
    expect(line.tabs).toEqual({ docs: 3 })
  })

  it('drops a trail word that could carry a path, a file name or a sentence', () => {
    const line = parse({
      kind: 'renderer',
      trail: [
        { t: 1, a: 'tab-open:docs' },
        { t: 2, a: 'opened C:\\Users\\someone\\salary.xlsx' },
        { t: 3, a: '/home/someone/plan.docx' },
        { t: 4, a: 'Save File' },
        { t: -1, a: 'save' },
        { t: 5, a: 'save' },
      ],
    })
    expect(line.trail).toEqual([
      { t: 1, a: 'tab-open:docs' },
      { t: 5, a: 'save' },
    ])
  })

  it('keeps the newest 24 actions of a longer trail', () => {
    const trail = Array.from({ length: 40 }, (_, i) => ({ t: i, a: 'tab-open:docs' }))
    const kept = parse({ kind: 'renderer', trail }).trail as { t: number }[]
    expect(kept).toHaveLength(24)
    expect(kept[0]?.t).toBe(16)
    expect(kept[23]?.t).toBe(39)
  })

  it('accepts only a React error number as the code', () => {
    expect(parse({ kind: 'renderer-error', code: '185' })).toMatchObject({ code: '185' })
    expect(
      parse({ kind: 'renderer-error', code: 'Cannot read properties of undefined' }),
    ).not.toHaveProperty('code')
    expect(parse({ kind: 'renderer-error', code: '12345' })).not.toHaveProperty('code')
  })

  it('keeps frames of the form function@bundle.js:line:column and nothing else', () => {
    const line = parse({
      kind: 'renderer-error',
      frames: [
        'Ke@index-Dk3f9a.js:12:3456',
        'https://host/assets/index.js:1:2',
        'C:\\Users\\someone\\app\\index.js:1:2',
        'TypeError: Cannot read properties of undefined (reading "text")',
        'fn@/home/someone/plan.docx:1:2',
        'fn@index.js',
        'fn@index.js:1:2',
      ],
    })
    expect(line.frames).toEqual(['Ke@index-Dk3f9a.js:12:3456', 'fn@index.js:1:2'])
  })

  it('keeps the top 6 frames of a deeper stack', () => {
    const frames = Array.from({ length: 12 }, (_, i) => `f${i}@index.js:${i + 1}:1`)
    expect(parse({ kind: 'renderer-error', frames }).frames).toHaveLength(6)
  })

  it('stays small even when every detail is at its limit', () => {
    const line = crashLine(
      {
        kind: 'renderer-error',
        reason: 'x'.repeat(47),
        editor: 'e'.repeat(47),
        uptimeS: 99_999_999,
        tabs: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`editor${i}`, 99])),
        trail: Array.from({ length: 100 }, (_, i) => ({ t: 99_999_999 + i, a: 'a'.repeat(32) })),
        code: '9999',
        frames: Array.from(
          { length: 20 },
          () => `${'f'.repeat(40)}@${'b'.repeat(55)}.js:9999999:9999999`,
        ),
      },
      AT,
    )
    expect(Buffer.byteLength(line)).toBeLessThan(4096)
  })
})
