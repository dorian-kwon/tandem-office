import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { learnFinalPaths } from '../src/main/translate/wiki-import'

const { workers } = vi.hoisted(() => ({ workers: [] as EventEmitter[] }))
vi.mock('node:worker_threads', () => ({
  Worker: class extends EventEmitter {
    constructor() {
      super()
      workers.push(this)
    }
  },
}))
vi.mock('@genoffice/file-parse', () => ({
  rhwpWasmPath: () => 'wasm',
  resolveParseSidecarPath: () => undefined,
}))
vi.mock('../src/main/translate/wiki-import-worker?modulePath', () => ({ default: 'worker.js' }))

it('serializes every import and excludes unchanged input without hiding failures', async () => {
  const options = { profileDir: '/profile', cliEntry: '', lang: 'en' as const }
  const first = learnFinalPaths(['/a', '/b', '/c'], options)
  const second = learnFinalPaths(['/d'], options)
  await vi.waitFor(() => expect(workers).toHaveLength(1))
  workers[0]!.emit('message', { index: 0, status: 'unchanged-source' })
  workers[0]!.emit('message', { index: 1, status: 'updated' })
  workers[0]!.emit('error', new Error('worker interrupted'))
  await Promise.resolve()
  expect(workers).toHaveLength(1)
  workers[0]!.emit('exit', 1)
  expect(await first).toEqual([
    { name: 'b', status: 'updated' },
    { name: 'c', status: 'failed' },
  ])
  await vi.waitFor(() => expect(workers).toHaveLength(2))
  workers[1]!.emit('message', { index: 0, status: 'unchanged-source' })
  workers[1]!.emit('exit', 0)
  expect(await second).toEqual([])
})
