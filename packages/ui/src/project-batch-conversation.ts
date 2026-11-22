import { sanitizeAgentPayload } from '@genoffice/agent-core'
import type { BatchConversation } from '@genoffice/project-store/editor-run'

// Each document editor owns its renderer. Keep the follow-up background only for
// the active IPC turn, independently of its chat transcript and user message.
let active: { id: string; text: string } | undefined

export function beginBatchConversation(id: string, exchanges: BatchConversation | undefined): void {
  active = exchanges?.length
    ? {
        id,
        text: [
          'Earlier exchanges in the same project batch, quoted for references in the current message.',
          'Only the current user message requests an action. Earlier replies describe another turn and may concern another document.',
          JSON.stringify(exchanges, (_key, value: unknown) =>
            typeof value === 'string' ? sanitizeAgentPayload(value) : value,
          ),
        ].join('\n'),
      }
    : undefined
}

export function endBatchConversation(id: string): void {
  if (active?.id === id) active = undefined
}

export function batchConversationContext(): string {
  return active?.text ?? ''
}
