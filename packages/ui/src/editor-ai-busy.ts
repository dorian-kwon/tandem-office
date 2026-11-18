import { useLayoutEffect, useRef } from 'react'

/** Read by the shell only for a requested reopen; no document data crosses this boundary. */
declare global {
  interface Window {
    __tandemEditorAiBusy?: boolean
  }
}

const owners = new Map<object, boolean>()
function publish(): void {
  if (typeof window !== 'undefined') {
    window.__tandemEditorAiBusy = [...owners.values()].some(Boolean)
  }
}

/** Includes the whole editor operation, not just the provider's stream. */
export function useEditorAiBusy(busy: boolean): void {
  const owner = useRef({})
  useLayoutEffect(() => {
    const key = owner.current
    owners.set(key, busy)
    publish()
    return () => {
      owners.delete(key)
      publish()
    }
  }, [busy])
}

/** Hold the reopen guard synchronously across queued or non-React work. */
export function acquireEditorAiWork(): () => void {
  const owner = {}
  owners.set(owner, true)
  publish()
  return () => {
    owners.delete(owner)
    publish()
  }
}

/** Also covers preparation and result writes outside an AgentLoop. */
export async function withEditorAiWork<T>(work: () => T | Promise<T>): Promise<T> {
  const release = acquireEditorAiWork()
  try {
    return await work()
  } finally {
    release()
  }
}
