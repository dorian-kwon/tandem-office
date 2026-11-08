import { describe, expect, it } from 'vitest'
import type { AgentStreamCallbacks, AgentTransport } from '@genoffice/agent-core'
import { integrateComparison } from '../src/renderer/compare/integration'

function setup() {
  let callbacks!: AgentStreamCallbacks
  let cancelled = false
  const transport: AgentTransport = {
    stream: (_request, cb) => {
      callbacks = cb
      return {
        cancel: () => {
          cancelled = true
          cb.onDone()
        },
      }
    },
  }
  return { transport, callbacks: () => callbacks, cancelled: () => cancelled }
}
describe('comparison integration', () => {
  it('collects the chosen app AI answer without executing tools', async () => {
    const fake = setup()
    const result = integrateComparison(
      fake.transport,
      { system: 's', user: 'u' },
      new AbortController().signal,
    )
    fake.callbacks().onDelta('New ')
    fake.callbacks().onDelta('text')
    fake.callbacks().onDone()
    expect(await result).toEqual({ ok: true, text: 'New text' })
  })
  it('stop cancels only this integration and discards partial output', async () => {
    const fake = setup()
    const controller = new AbortController()
    const result = integrateComparison(
      fake.transport,
      { system: 's', user: 'u' },
      controller.signal,
    )
    fake.callbacks().onDelta('Partial')
    controller.abort()
    expect(fake.cancelled()).toBe(true)
    expect(await result).toEqual({ ok: false, reason: 'stopped' })
  })
  it('an already stopped run sends nothing', async () => {
    const controller = new AbortController()
    controller.abort()
    const transport: AgentTransport = {
      stream: () => {
        throw new Error('must not start')
      },
    }
    expect(
      await integrateComparison(transport, { system: 's', user: 'u' }, controller.signal),
    ).toEqual({ ok: false, reason: 'stopped' })
  })
})
