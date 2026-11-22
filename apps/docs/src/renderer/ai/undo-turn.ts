import type { AgentSkill } from '@genoffice/agent-core'

export const UNDO_AI_TURN = 'undo_last_ai_edit'

/** The latest turn is the only eligible one. A stale checkpoint must never
 * cause the previous translation or a subsequent manual edit to be undone. */
export function createUndoTurnSkill(restore: () => boolean, label: () => string): AgentSkill {
  return {
    id: 'word-edit-history',
    systemPrompt:
      'When the user asks to undo the last AI edit or go back to the state before it, call undo_last_ai_edit once. It restores the complete last edit turn including body and tables. Report its actual result. If there is no live checkpoint, explain that limitation. A stored chat transcript is not a document backup.',
    tools: [
      {
        name: UNDO_AI_TURN,
        description:
          'Restore the open Word document to just before the most recent AI edit turn in this chat. Use only at the user’s explicit request. Leaves earlier translation intact.',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
    ],
    executeTool: (call, signal) => {
      const ok = call.name === UNDO_AI_TURN && !signal?.aborted && restore()
      return {
        mutated: ok,
        isError: !ok,
        summary: label(),
        output: ok
          ? 'Restored the document to before the latest AI edit turn.'
          : 'No applicable live checkpoint for the last AI edit. The document was left untouched.',
      }
    },
  }
}
