import { describe, expect, it, vi } from 'vitest'
import {
  deferredRendererReopen,
  editorAiBusy,
  rendererMemoryHot,
  rendererMemoryMB,
  watchdogActions,
  withMainEditorWork,
} from '../src/main/renderer-watchdog-policy'

describe('renderer memory pressure', () => {
  it('prefers private bytes, including zero, and falls back to working set', () => {
    expect(rendererMemoryMB({ privateBytes: 1024, workingSetSize: 4096 })).toBe(1)
    expect(rendererMemoryMB({ privateBytes: 0, workingSetSize: 4096 })).toBe(0)
    expect(rendererMemoryMB({ workingSetSize: 4096 })).toBe(4)
  })
  it('requires both 1.5 GiB and system pressure, or over half all RAM', () => {
    expect(rendererMemoryHot(2000, { totalMB: 32768, freeMB: 10000 })).toBe(false)
    expect(rendererMemoryHot(2000, { totalMB: 32768, freeMB: 3276 })).toBe(true)
    expect(rendererMemoryHot(1536, { totalMB: 8192, freeMB: 100 })).toBe(false)
    expect(rendererMemoryHot(1537, { totalMB: 8192, freeMB: 1536 })).toBe(false)
    expect(rendererMemoryHot(1537, { totalMB: 8192, freeMB: 1535 })).toBe(true)
    expect(rendererMemoryHot(4096, { totalMB: 8192, freeMB: 4000 })).toBe(false)
    expect(rendererMemoryHot(4097, { totalMB: 8192, freeMB: 4000 })).toBe(true)
  })
})
it('keeps wait at the default/cancel index and offers reopen only for a file', () => {
  expect(watchdogActions(true)).toEqual(['wait', 'reopen', 'close'])
  expect(watchdogActions(false)).toEqual(['wait', 'close'])
})
it('requires explicit editor idle, including for unknown/broken renderers', async () => {
  const wc = {
    isDestroyed: () => false,
    executeJavaScript: vi.fn(async (): Promise<unknown> => false),
  }
  expect(await editorAiBusy(wc)).toBe(false)
  wc.executeJavaScript.mockResolvedValue(undefined)
  expect(await editorAiBusy(wc)).toBe(true)
  wc.executeJavaScript.mockRejectedValue(new Error('gone'))
  expect(await editorAiBusy(wc)).toBe(true)
})
it('defers through provider completion until full editor work finishes', async () => {
  let busy = true
  const reopen = vi.fn(async () => {})
  const request = deferredRendererReopen({ exists: () => true, busy: async () => busy, reopen })
  request.request()
  await request.check()
  // The provider has finished, but document application/save is still busy.
  await request.check()
  expect(reopen).not.toHaveBeenCalled()
  busy = false
  await request.check()
  await request.check()
  expect(reopen).toHaveBeenCalledTimes(1)
  expect(request.pending).toBe(false)
})
it('drops scheduled work when the document closes or a wait/cancel replaces it', async () => {
  let exists = true
  let answer!: (busy: boolean) => void
  const reopen = vi.fn(async () => {})
  const request = deferredRendererReopen({
    exists: () => exists,
    busy: () =>
      new Promise((resolve) => {
        answer = resolve
      }),
    reopen,
  })
  request.request()
  const checking = request.check()
  exists = false
  answer(false)
  await checking
  expect(request.pending).toBe(false)
  expect(reopen).not.toHaveBeenCalled()
  exists = true
  request.request()
  request.cancel()
  await request.check()
  expect(reopen).not.toHaveBeenCalled()
})
it('does not repeat a cancelled or failed save/reopen', async () => {
  const reopen = vi.fn(async () => {
    throw new Error('save failed')
  })
  const request = deferredRendererReopen({ exists: () => true, busy: async () => false, reopen })
  request.request()
  await request.check()
  await request.check()
  expect(reopen).toHaveBeenCalledTimes(1)
})

it('keeps main-process save leases busy until the entire write settles', async () => {
  const wc = { id: 99, isDestroyed: () => false, executeJavaScript: async () => false }
  let finish!: () => void
  const saving = withMainEditorWork(
    wc.id,
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  expect(await editorAiBusy(wc)).toBe(true)
  finish()
  await saving
  expect(await editorAiBusy(wc)).toBe(false)
})

it('keeps the requested reopen when a new AI run starts during the save guard', async () => {
  const reopen = vi.fn(async (): Promise<'busy' | 'reopened'> => 'busy')
  const request = deferredRendererReopen({ exists: () => true, busy: async () => false, reopen })
  request.request()
  await request.check()
  expect(request.pending).toBe(true)
  reopen.mockResolvedValue('reopened')
  await request.check()
  expect(request.pending).toBe(false)
  expect(reopen).toHaveBeenCalledTimes(2)
})
