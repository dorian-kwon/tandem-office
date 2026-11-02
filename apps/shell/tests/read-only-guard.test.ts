import { describe, expect, it, vi } from 'vitest'

import {
  installReadOnlyGuard,
  READ_ONLY_IPC_ANSWERS,
  readOnlyBlocksInput,
} from '../src/main/read-only-guard'
import { MARKDOWN_CHANNELS } from '../../markdown/src/shared/ipc'
import { HTML_CHANNELS } from '../../html/src/shared/ipc'
import { EPUB_CHANNELS } from '../../epub/src/shared/ipc'
import { MINDMAP_CHANNELS } from '../../mindmap/src/shared/ipc'
import { HWP_CHANNELS } from '../../hwp/src/shared/ipc'

const key = (
  k: string,
  mods: Partial<Record<'control' | 'meta' | 'alt' | 'shift', boolean>> = {},
) => ({
  type: 'keyDown',
  key: k,
  control: false,
  meta: false,
  alt: false,
  shift: false,
  ...mods,
})

describe('source pane rejects edit commands (readOnlyBlocksInput)', () => {
  it('blocks typing, IME input, deleting, Enter and Tab', () => {
    for (const k of [
      'a',
      'Z',
      '1',
      ' ',
      'Enter',
      'Backspace',
      'Delete',
      'Tab',
      'Process',
      'Insert',
    ])
      expect(readOnlyBlocksInput(key(k), 'win32')).toBe(true)
    expect(readOnlyBlocksInput(key('A', { shift: true }), 'win32')).toBe(true)
    // Option+letter types a character on macOS
    expect(readOnlyBlocksInput(key('å', { alt: true }), 'darwin')).toBe(true)
  })

  it('blocks paste, cut, undo, redo and save chords', () => {
    for (const k of ['v', 'x', 'z', 'y', 's', 'b', 'i', 'u', 'h']) {
      expect(readOnlyBlocksInput(key(k, { control: true }), 'win32')).toBe(true)
      expect(readOnlyBlocksInput(key(k, { meta: true }), 'darwin')).toBe(true)
    }
    expect(readOnlyBlocksInput(key('S', { meta: true, shift: true }), 'darwin')).toBe(true)
  })

  it('lets reading through: moving, selecting, copying, finding, zooming, tab keys', () => {
    for (const k of ['ArrowDown', 'ArrowLeft', 'PageDown', 'Home', 'End', 'Escape', 'F3', 'Shift'])
      expect(readOnlyBlocksInput(key(k), 'win32')).toBe(false)
    expect(readOnlyBlocksInput(key('ArrowDown', { shift: true }), 'win32')).toBe(false)
    for (const k of ['c', 'a', 'f', 'g', 'p', 'w', '=', '-', '0', 'Tab'])
      expect(readOnlyBlocksInput(key(k, { control: true }), 'win32')).toBe(false)
    expect(readOnlyBlocksInput(key('C', { meta: true }), 'darwin')).toBe(false)
  })

  it('never blocks a key release', () => {
    expect(readOnlyBlocksInput({ ...key('a'), type: 'keyUp' }, 'win32')).toBe(false)
  })
})

describe('save channels refused for a read-only view', () => {
  it('covers each editor save channel that writes the opened file', () => {
    const channels = Object.keys(READ_ONLY_IPC_ANSWERS)
    for (const channel of [
      // apps/docs/src/preload/index.ts: save, Save As (pick, then write)
      'docs:save',
      'docs:save-as-pick',
      'docs:save-as',
      'slides:save',
      MARKDOWN_CHANNELS.save,
      HTML_CHANNELS.save,
      EPUB_CHANNELS.save,
      MINDMAP_CHANNELS.save,
      HWP_CHANNELS.beginSave,
    ])
      expect(channels).toContain(channel)
  })

  it('answers a save with a failure the editors already understand', () => {
    for (const [channel, answer] of Object.entries(READ_ONLY_IPC_ANSWERS)) {
      if (channel === 'docs:save-as-pick') expect(answer).toBeNull()
      else if (channel === 'app:get-auto-save-default')
        expect(answer).toEqual({ on: false, updatedAt: 0 })
      else expect(answer).toMatchObject({ ok: false, error: expect.any(String) })
    }
  })
})

describe('installReadOnlyGuard', () => {
  function fakeContents() {
    const listeners = new Map<string, (...a: unknown[]) => void>()
    return {
      listeners,
      on: vi.fn((event: string, fn: (...a: unknown[]) => void) => listeners.set(event, fn)),
      removeListener: vi.fn((event: string) => listeners.delete(event)),
      ipc: { handle: vi.fn(), removeHandler: vi.fn() },
    }
  }

  it('cancels blocked keys and answers save channels for this view only', async () => {
    const contents = fakeContents()
    const remove = installReadOnlyGuard(contents as never)
    const prevent = vi.fn()
    contents.listeners.get('before-input-event')!(
      { preventDefault: prevent },
      key('v', { control: true }),
    )
    expect(prevent).toHaveBeenCalledTimes(1)
    contents.listeners.get('before-input-event')!({ preventDefault: prevent }, key('ArrowDown'))
    expect(prevent).toHaveBeenCalledTimes(1)
    const call = contents.ipc.handle.mock.calls.find(([c]) => c === 'docs:save')!
    expect(await (call[1] as () => unknown)()).toMatchObject({ ok: false })
    remove()
    expect(contents.listeners.has('before-input-event')).toBe(false)
    expect(contents.ipc.removeHandler).toHaveBeenCalledWith('docs:save')
  })
})
