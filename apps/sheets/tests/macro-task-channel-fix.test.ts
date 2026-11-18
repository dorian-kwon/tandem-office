import { Layer, Scene } from '@univerjs/engine-render'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  immediateMacroTask,
  installMacroTaskChannelFix,
} from '../src/renderer/macro-task-channel-fix'

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

/** every MessageChannel opened during a test, with how many of its ports were closed */
function trackChannels(): { opened: number; closedPorts: () => number; restore(): void } {
  const Real = globalThis.MessageChannel
  let opened = 0
  let closed = 0
  class Tracked extends Real {
    constructor() {
      super()
      opened += 1
      for (const port of [this.port1, this.port2]) {
        const close = port.close.bind(port)
        port.close = () => {
          closed += 1
          close()
        }
      }
    }
  }
  globalThis.MessageChannel = Tracked as unknown as typeof MessageChannel
  return {
    get opened() {
      return opened
    },
    closedPorts: () => closed,
    restore: () => {
      globalThis.MessageChannel = Real
    },
  }
}

let tracker: ReturnType<typeof trackChannels> | null = null
afterEach(() => {
  tracker?.restore()
  tracker = null
})

describe('immediateMacroTask', () => {
  it('runs the callback once and closes both ports after it fires', async () => {
    tracker = trackChannels()
    const callback = vi.fn()
    immediateMacroTask(callback)
    await flush()
    expect(callback).toHaveBeenCalledTimes(1)
    expect(tracker.opened).toBe(1)
    expect(tracker.closedPorts()).toBe(2)
  })

  it('a cancelled task never runs and its ports are closed', async () => {
    tracker = trackChannels()
    const callback = vi.fn()
    const cancel = immediateMacroTask(callback)
    cancel()
    await flush()
    expect(callback).not.toHaveBeenCalled()
    expect(tracker.closedPorts()).toBe(2)
  })

  it('cancelling after it fired is harmless', async () => {
    const callback = vi.fn()
    const cancel = immediateMacroTask(callback)
    await flush()
    expect(() => cancel()).not.toThrow()
    expect(callback).toHaveBeenCalledTimes(1)
  })
})

describe('installMacroTaskChannelFix', () => {
  beforeAll(() => installMacroTaskChannelFix())

  it('Layer.makeDirtyWithDebounce coalesces calls and leaves no open channel', async () => {
    tracker = trackChannels()
    const makeDirty = vi.fn()
    const layer = { makeDirty, _debounceDirtyFunc: null as null | (() => void) }
    const debounce = Layer.prototype.makeDirtyWithDebounce as (this: unknown, s?: boolean) => void
    debounce.call(layer, true)
    debounce.call(layer, true)
    debounce.call(layer, false)
    await flush()
    // only the last request runs, like stock Univer
    expect(makeDirty).toHaveBeenCalledTimes(1)
    expect(makeDirty).toHaveBeenCalledWith(false)
    expect(layer._debounceDirtyFunc).toBeNull()
    expect(tracker.opened).toBe(3)
    expect(tracker.closedPorts()).toBe(6)
  })

  it('a scene transformer debounces refreshControls without leaking channels', async () => {
    const transformerProto = {
      refreshControls: vi.fn(),
      _debounceClearFunc: null as null | (() => void),
      debounceRefreshControls() {
        throw new Error('stock implementation must be replaced')
      },
    }
    const transformer = Object.create(transformerProto) as typeof transformerProto
    const scene = Object.create(Scene.prototype) as {
      _transformer: unknown
      getTransformer(): unknown
    }
    scene._transformer = transformer
    tracker = trackChannels()
    const got = scene.getTransformer() as typeof transformerProto
    got.debounceRefreshControls()
    got.debounceRefreshControls()
    await flush()
    expect(transformerProto.refreshControls).toHaveBeenCalledTimes(1)
    expect(got._debounceClearFunc).toBeNull()
    expect(tracker.closedPorts()).toBe(2 * tracker.opened)
  })
})
