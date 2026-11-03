import { createHash } from 'node:crypto'

/**
 * Which conversations already carry the fixed part of a translation context
 * (the app-wide system prompt, the project prompt, the language pair and the
 * editing rules), so a later request of the same conversation can send only
 * a one-line marker in its place.
 *
 * Safety rules (task 4 of the translation follow-ups):
 * - Held in memory only, never written to disk: an app restart forgets every
 *   conversation, and the next request sends the fixed part again.
 * - Keyed by conversation id and project folder: a new chat (a cleared chat
 *   gets a new id) or another project sends it again.
 * - Recorded only for a provider the caller says keeps the earlier system
 *   prompt of the conversation. None of today's paths does: the Claude
 *   program runs one process per turn with `--no-session-persistence` and
 *   gets the system prompt anew on every turn, the ChatGPT direct connection
 *   sends `store: false` with the whole input each time, the Codex app-server
 *   starts a new thread whenever the system text changes, and the PDF window
 *   sends every batch on its own. So every request carries the fixed part
 *   until a path that really keeps it passes `providerKeepsSystem: true`.
 * - Any doubt (no id, no ledger, an unknown provider, a full ledger) sends it.
 *
 * Nothing here logs: the hashed text is the person's own material.
 */

/** Most conversations remembered at once; the oldest is forgotten (and sends again) */
export const FIXED_CONTEXT_LEDGER_MAX = 200

/** The marker that stands in for the fixed part */
export const FIXED_CONTEXT_MARKER_PREFIX = 'fixed-context: '

/** sha-256 of the fixed part, as hex */
export function fixedContextHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** The one-line marker sent in place of the fixed part: its first 8 hash characters */
export function fixedContextMarker(hash: string): string {
  return `${FIXED_CONTEXT_MARKER_PREFIX}${hash.slice(0, 8)}`
}

/** The conversation one request belongs to, as the AI panel reports it */
export interface FixedContextConversation {
  /** the panel's chat id; a new or cleared chat has a new one */
  id: string
  /**
   * true only when the provider of this request keeps the earlier system
   * prompt of the conversation; false (or any doubt) sends the fixed part
   */
  providerKeepsSystem: boolean
}

export class FixedContextLedger {
  private readonly sent = new Map<string, string>()

  /** conversations remembered */
  get size(): number {
    return this.sent.size
  }

  /**
   * Whether this request must carry the fixed part with `hash`. True for the
   * first request of a conversation, after the hash changed, and always when
   * the provider keeps no earlier system prompt or there is no conversation id.
   * A true answer for a session-keeping provider records the hash.
   */
  shouldSend(
    conversationId: string,
    projectKey: string,
    hash: string,
    providerKeepsSystem: boolean,
  ): boolean {
    if (!conversationId) return true
    const key = `${conversationId}\u0000${projectKey}`
    if (!providerKeepsSystem) {
      // what this provider saw is gone by the next request
      this.sent.delete(key)
      return true
    }
    if (this.sent.get(key) === hash) {
      // refresh its place: the oldest unused conversation is the one dropped
      this.sent.delete(key)
      this.sent.set(key, hash)
      return false
    }
    this.sent.delete(key)
    this.sent.set(key, hash)
    while (this.sent.size > FIXED_CONTEXT_LEDGER_MAX) {
      const oldest = this.sent.keys().next().value
      if (oldest === undefined) break
      this.sent.delete(oldest)
    }
    return true
  }

  /** forget one conversation (every project in it): its next request sends the fixed part */
  forget(conversationId: string): void {
    const prefix = `${conversationId}\u0000`
    for (const key of [...this.sent.keys()]) if (key.startsWith(prefix)) this.sent.delete(key)
  }

  /** forget every conversation */
  clear(): void {
    this.sent.clear()
  }
}
