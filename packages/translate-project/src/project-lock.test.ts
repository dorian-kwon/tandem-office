import { describe, expect, it } from 'vitest'
import { withProjectLock } from './project-lock'

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('withProjectLock', () => {
  it('runs tasks on one dir one after another', async () => {
    const log: string[] = []
    const task = (n: string, ms: number) => async () => {
      log.push(`start ${n}`)
      await tick(ms)
      log.push(`end ${n}`)
    }
    await Promise.all([withProjectLock('/p', task('a', 20)), withProjectLock('/p/', task('b', 1))])
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b'])
  })

  it('a rejecting task does not block the next one', async () => {
    const failing = withProjectLock('/q', () => Promise.reject(new Error('boom')))
    const next = withProjectLock('/q', () => Promise.resolve('ok'))
    await expect(failing).rejects.toThrow('boom')
    await expect(next).resolves.toBe('ok')
  })

  it('different dirs do not block each other', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const slow = withProjectLock('/x', () => gate)
    await expect(withProjectLock('/y', () => Promise.resolve(1))).resolves.toBe(1)
    release()
    await slow
  })
})
