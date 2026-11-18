/**
 * Univer's `requestImmediateMacroTask` (core 0.25.1) opens a MessageChannel,
 * sets `port1.onmessage` and closes the ports only when the caller runs the
 * returned cancel function. Two render-engine callers drop that function after
 * the task fires instead of running it — `Layer.makeDirtyWithDebounce` and
 * `Transformer.debounceRefreshControls` — so every call leaves an entangled
 * port pair with a live handler behind. Blink keeps such ports alive, so they
 * are never collected: about 110 per AI request in a translation workbook,
 * roughly 4.5 KB of native memory each, growing for as long as the tab is open.
 *
 * The replacements debounce exactly like the originals (only the last request
 * of a burst runs, on the next macrotask) but close both ports as soon as the
 * task fires or is cancelled. The formula engine's own use cancels every task
 * when a calculation ends, so it is left alone.
 */
import { Layer, Scene } from '@univerjs/engine-render'

/** run `callback` on the next macrotask; the returned function cancels it. Ports never outlive the task. */
export function immediateMacroTask(callback: () => void): () => void {
  const channel = new MessageChannel()
  let done = false
  const close = (): void => {
    if (done) return
    done = true
    channel.port1.onmessage = null
    channel.port1.close()
    channel.port2.close()
  }
  channel.port1.onmessage = () => {
    if (done) return
    close()
    callback()
  }
  channel.port2.postMessage(null)
  return close
}

interface LayerLike {
  _debounceDirtyFunc: (() => void) | null
  makeDirty(state?: boolean): unknown
}

interface TransformerLike {
  _debounceClearFunc: (() => void) | null
  refreshControls(): unknown
  debounceRefreshControls(): void
}

const patchedTransformerProtos = new WeakSet<object>()

function patchTransformerProto(transformer: unknown): void {
  if (!transformer || typeof transformer !== 'object') return
  const proto = Object.getPrototypeOf(transformer) as TransformerLike | null
  if (!proto || patchedTransformerProtos.has(proto)) return
  patchedTransformerProtos.add(proto)
  if (typeof proto.debounceRefreshControls !== 'function') return
  proto.debounceRefreshControls = function (this: TransformerLike): void {
    this._debounceClearFunc?.()
    this._debounceClearFunc = immediateMacroTask(() => {
      this._debounceClearFunc = null
      this.refreshControls()
    })
  }
}

let installed = false

export function installMacroTaskChannelFix(): void {
  if (installed) return
  installed = true
  const layerProto = Layer.prototype as unknown as LayerLike & {
    makeDirtyWithDebounce(state?: boolean): void
  }
  if (typeof layerProto.makeDirtyWithDebounce === 'function') {
    layerProto.makeDirtyWithDebounce = function (this: LayerLike, state = true): void {
      this._debounceDirtyFunc?.()
      this._debounceDirtyFunc = immediateMacroTask(() => {
        this._debounceDirtyFunc = null
        this.makeDirty(state)
      })
    }
  }
  // Transformer is not exported: patch its prototype the first time a scene hands one out
  const sceneProto = Scene.prototype as unknown as { getTransformer(): unknown }
  const getTransformer = sceneProto.getTransformer
  if (typeof getTransformer === 'function') {
    sceneProto.getTransformer = function (this: unknown): unknown {
      const transformer = getTransformer.call(this)
      patchTransformerProto(transformer)
      return transformer
    }
  }
}
