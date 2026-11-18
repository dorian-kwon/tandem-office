import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessMetric } from 'electron'

const fake = vi.hoisted(() => ({
  metrics: [] as ProcessMetric[],
  wc: {
    id: 1,
    isDestroyed: vi.fn(() => false),
    getOSProcessId: () => 100,
    getURL: () => 'file:///app/index.html',
  },
  show: vi.fn(async () => ({ response: 0 })),
  write: vi.fn(async () => {}),
}))
vi.mock('electron', () => ({
  app: { getAppMetrics: () => fake.metrics, getPath: () => '/tmp' },
  webContents: { getAllWebContents: () => [fake.wc] },
  dialog: { showMessageBox: fake.show },
}))
vi.mock('node:fs/promises', () => ({ writeFile: fake.write }))
import { startRendererWatchdog } from '../src/main/renderer-watchdog'

let stop: (() => void) | undefined
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  fake.show.mockResolvedValue({ response: 0 })
  fake.wc.isDestroyed.mockReturnValue(false)
  fake.metrics = [
    {
      pid: 100,
      type: 'Tab',
      memory: { privateBytes: 2000 * 1024, workingSetSize: 3000 * 1024 },
      cpu: { cumulativeCPUUsage: 0 },
    } as ProcessMetric,
  ]
})
afterEach(() => {
  stop?.()
  stop = undefined
  vi.useRealTimers()
})
function start({ freeMB = 500, file = true, busy = false } = {}) {
  const close = vi.fn(async () => {})
  const reopen = vi.fn(async () => {})
  const isAiBusy = vi.fn(async () => busy)
  stop = startRendererWatchdog({
    describe: () => ({
      kind: 'docs',
      title: 'test',
      ...(file ? { filePath: '/tmp/test.docx' } : {}),
    }),
    parentWindow: () => null,
    closeDocument: close,
    reopenDocument: reopen,
    isAiBusy,
    readMemory: () => ({ freeMB, totalMB: 16384 }),
    t: (key) => key,
    sampleMs: 100,
    hotSamplesBeforeReport: 1,
    reportCooldownMs: 1000,
    profileMs: 0,
  })
  return { close, reopen, isAiBusy }
}
it('does not warn for a large renderer while system memory is plentiful', async () => {
  start({ freeMB: 8000 })
  await vi.advanceTimersByTimeAsync(100)
  expect(fake.show).not.toHaveBeenCalled()
})
it('uses private memory rather than a larger working set', async () => {
  fake.metrics[0]!.memory.privateBytes = 500 * 1024
  start()
  await vi.advanceTimersByTimeAsync(100)
  expect(fake.show).not.toHaveBeenCalled()
})
it('offers wait as default and cancel with file reopen and normal close', async () => {
  const actions = start()
  await vi.advanceTimersByTimeAsync(100)
  expect(fake.show).toHaveBeenCalledWith(
    expect.objectContaining({
      buttons: ['watchdogWait', 'watchdogReopen', 'watchdogClose'],
      defaultId: 0,
      cancelId: 0,
    }),
  )
  expect(actions.reopen).not.toHaveBeenCalled()
  expect(actions.close).not.toHaveBeenCalled()
})
it('offers a deferred reopen while the full editor AI operation is busy', async () => {
  fake.show.mockResolvedValue({ response: 1 })
  const actions = start({ busy: true })
  await vi.advanceTimersByTimeAsync(100)
  expect(fake.show).toHaveBeenCalledWith(
    expect.objectContaining({
      buttons: ['watchdogWait', 'watchdogReopenAfterAi', 'watchdogClose'],
      detail: 'watchdogBody\n\nwatchdogAiBusy',
    }),
  )
  expect(actions.reopen).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(100)
  expect(actions.reopen).not.toHaveBeenCalled()
  actions.isAiBusy.mockResolvedValue(false)
  await vi.advanceTimersByTimeAsync(100)
  expect(actions.reopen).toHaveBeenCalledTimes(1)
})
it('never reopens after the renderer closes during a deferred request', async () => {
  fake.show.mockResolvedValue({ response: 1 })
  const actions = start({ busy: true })
  await vi.advanceTimersByTimeAsync(100)
  fake.wc.isDestroyed.mockReturnValue(true)
  actions.isAiBusy.mockResolvedValue(false)
  await vi.advanceTimersByTimeAsync(100)
  expect(actions.reopen).not.toHaveBeenCalled()
})
describe.each([
  { file: true, response: 2 },
  { file: false, response: 1 },
])('close mapping %o', ({ file, response }) => {
  it('routes close correctly with or without a reopen button', async () => {
    fake.show.mockResolvedValue({ response })
    const actions = start({ file })
    await vi.advanceTimersByTimeAsync(100)
    expect(actions.close).toHaveBeenCalledTimes(1)
    expect(actions.reopen).not.toHaveBeenCalled()
  })
})
it('keeps the cumulative one-core CPU threshold independent of memory pressure', async () => {
  start({ freeMB: 8000 })
  await vi.advanceTimersByTimeAsync(100)
  fake.metrics[0]!.cpu.cumulativeCPUUsage = 0.1
  await vi.advanceTimersByTimeAsync(100)
  expect(fake.show).toHaveBeenCalledTimes(1)
})
