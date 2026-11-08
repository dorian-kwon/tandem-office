import type { AgentTransport, AgentStreamHandle } from '@genoffice/agent-core'
import type { CompareAnswer } from '../../shared/compare'

/** One tool-free app AI turn; stop cancels this request and never accepts partial output. */
export function integrateComparison(
  transport: AgentTransport,
  request: { system: string; user: string },
  signal: AbortSignal,
): Promise<CompareAnswer> {
  if (signal.aborted) return Promise.resolve({ ok: false, reason: 'stopped' })
  return new Promise((resolve) => {
    let text = ''
    let handle: AgentStreamHandle | undefined
    let settled = false
    const finish = (answer: CompareAnswer): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', cancel)
      resolve(answer)
    }
    const cancel = (): void => {
      finish({ ok: false, reason: 'stopped' })
      handle?.cancel()
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      handle = transport.stream(
        { system: request.system, messages: [{ role: 'user', text: request.user }], tools: [] },
        {
          onDelta: (delta) => {
            text += delta
          },
          onToolCall: () => {},
          onDone: () => finish({ ok: true, text }),
          onError: (reason) => finish({ ok: false, reason }),
        },
      )
      if (signal.aborted) handle.cancel()
    } catch (error) {
      finish({ ok: false, reason: String(error).slice(0, 200) })
    }
  })
}
