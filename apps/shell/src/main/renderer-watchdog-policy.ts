import { setTimeout, clearTimeout } from 'node:timers'
import type { MemoryReading } from './spare-view-policy'

const mainWork = new Map<number, number>()

/** Main-process MCP saves can outlive every renderer/provider request. */
export async function withMainEditorWork<T>(id: number, work: () => Promise<T>): Promise<T> {
  mainWork.set(id, (mainWork.get(id) ?? 0) + 1)
  try {
    return await work()
  } finally {
    const count = (mainWork.get(id) ?? 1) - 1
    if (count) mainWork.set(id, count)
    else mainWork.delete(id)
  }
}

export function rendererMemoryMB(memory: {
  privateBytes?: number
  workingSetSize: number
}): number {
  return (memory.privateBytes ?? memory.workingSetSize) / 1024
}

export function rendererMemoryHot(
  rendererMB: number,
  system: MemoryReading,
  limitMB = 1536,
): boolean {
  return (
    (rendererMB > limitMB && system.freeMB < Math.max(1536, system.totalMB * 0.1)) ||
    (system.totalMB > 0 && rendererMB > system.totalMB * 0.5)
  )
}

export type WatchdogReopenResult = 'reopened' | 'busy' | 'cancelled' | 'closed'

export type WatchdogAction = 'wait' | 'reopen' | 'close'
export function watchdogActions(canReopen: boolean): WatchdogAction[] {
  return canReopen ? ['wait', 'reopen', 'close'] : ['wait', 'close']
}

/** Unknown/failed probes keep a document open. Only an explicit idle reading may reopen it. */
export async function editorAiBusy(wc: {
  id?: number
  isDestroyed(): boolean
  executeJavaScript(script: string): Promise<unknown>
}): Promise<boolean> {
  if (wc.isDestroyed() || (wc.id !== undefined && mainWork.has(wc.id))) return true
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      wc.executeJavaScript('window.__tandemEditorAiBusy'),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 2000)
      }),
    ])
    return result !== false || (wc.id !== undefined && mainWork.has(wc.id))
  } catch {
    return true
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** A requested reopen waits through tool execution/application and dies with its document. */
export function deferredRendererReopen(deps: {
  exists(): boolean
  busy(): Promise<boolean>
  reopen(): Promise<WatchdogReopenResult | void>
}) {
  let pending = false
  let checking = false
  let revision = 0
  return {
    request(): void {
      pending = true
      revision++
    },
    cancel(): void {
      pending = false
      revision++
    },
    get pending(): boolean {
      return pending
    },
    async check(): Promise<void> {
      if (!pending || checking) return
      if (!deps.exists()) {
        pending = false
        return
      }
      checking = true
      const current = revision
      try {
        if (await deps.busy()) return
        if (current !== revision) return
        if (!pending || !deps.exists()) {
          pending = false
          return
        }
        const result = await deps.reopen()
        // A new AI run defers the same request; a save cancellation is final.
        if (current === revision) pending = result === 'busy' && deps.exists()
      } catch {
        if (current === revision) pending = false
      } finally {
        checking = false
      }
    },
  }
}
