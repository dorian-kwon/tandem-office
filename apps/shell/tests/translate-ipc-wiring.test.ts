import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// index.ts needs a running Electron, so its wiring is pinned by its source text
const source = readFileSync(join(__dirname, '../src/main/index.ts'), 'utf8')
const call = source.slice(source.indexOf('\nregisterTranslateIpc('))
const wiring = call.slice(0, call.indexOf('registerTabsIpc()'))

describe('translate IPC wiring in index.ts', () => {
  it('passes an open-documents check over tabs and detached windows', () => {
    expect(wiring).toContain('isPathOpen: (dir) =>')
    expect(wiring).toContain('tabManager?.openFilePaths()')
    expect(wiring).toContain('detachedFilePaths()')
    expect(wiring).toContain('isInsideRoot(dir, path)')
  })

  it('answers the shell window only', () => {
    expect(wiring).toContain('sender === shellWindow.webContents')
  })
})
