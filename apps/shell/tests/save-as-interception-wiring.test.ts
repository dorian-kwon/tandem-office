// Source-level wiring: every editor's own Save As asks the shell's interceptor before it
// shows a dialog, so the translation output never gets retargeted by an editor Save As.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const apps = resolve(__dirname, '../..')
const read = (p: string) => readFileSync(resolve(apps, p), 'utf8')

const editors: [string, string, RegExp][] = [
  [
    'docs',
    'docs/src/main/docs-main.ts',
    /'docs:save-as-pick'[\s\S]{0,900}interceptSaveAs\(event\.sender\.id\)/,
  ],
  [
    'sheets',
    'sheets/src/main/sheets-main.ts',
    /request\.mode === 'save-as' && interceptSaveAs\(event\.sender\.id\)/,
  ],
  [
    'slides',
    'slides/src/main/slides-main.ts',
    /'slides:save-as'[\s\S]{0,500}interceptSaveAs\(e\.sender\.id\)/,
  ],
  [
    'hwp',
    'hwp/src/main/hwp-main.ts',
    /\(mode === 'saveAs' \|\| hwpxCopy\) && interceptSaveAs\(wcId\)/,
  ],
  [
    'markdown',
    'markdown/src/main/markdown-main.ts',
    /mode === 'saveAs' && interceptSaveAs\(e\.sender\.id\)/,
  ],
  ['html', 'html/src/main/html-main.ts', /mode === 'saveAs' && interceptSaveAs\(e\.sender\.id\)/],
  ['epub', 'epub/src/main/epub-main.ts', /mode === 'saveAs' && interceptSaveAs\(wcId\)/],
  ['mindmap', 'mindmap/src/main/mindmap-main.ts', /mode === 'saveAs' && interceptSaveAs\(wcId\)/],
  [
    'pdf (shell savePdfAs)',
    'shell/src/main/index.ts',
    /async function savePdfAs[\s\S]{0,400}interceptSaveAs\(tab\.webContents\.id\)/,
  ],
]

describe('Save As interception wiring', () => {
  for (const [name, file, pattern] of editors) {
    it(`${name} asks the interceptor before its Save As dialog`, () => {
      const src = read(file)
      expect(src).toMatch(pattern)
      expect(src).toMatch(
        /import \{[^}]*\binterceptSaveAs\b[^}]*\} from '@genoffice\/electron-utils'|^\s+interceptSaveAs,$/m,
      )
    })
  }

  it('the shell registers the interceptor and reuses the copy-flow event', () => {
    const src = read('shell/src/main/index.ts')
    expect(src).toContain('setSaveAsInterceptor(')
    expect(src).toMatch(
      /translationSaveAsInterceptor\(\{[\s\S]{0,900}TRANSLATE_EVENTS\.saveAsRequested/,
    )
  })
})
