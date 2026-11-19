import type { AgentSkill } from './skill'
import type { AgentToolCall } from './types'

/** Only local reads of the open document can witness a quotation. */
export const translationBodyReads = new Set([
  'read_blocks',
  'read_runs',
  'read_document',
  'read_range',
  'read_cells',
  'read_slide',
  'read_source_units',
  'read_source',
  'read_pages',
  'read_chapter',
  'read_map',
  'read_topic',
])

function stableRead(name: string, args: Record<string, unknown>): boolean {
  return (
    !(name === 'read_range' || name === 'read_cells') ||
    (typeof args.sheetId === 'string' && !!args.sheetId)
  )
}

export interface Quotation {
  text: string
  near?: string
  name: string
  input: Record<string, unknown>
}

export function asQuotation(raw: unknown): Quotation | null {
  if (!raw || typeof raw !== 'object') return null
  const { text, near, name, input } = raw as Partial<Quotation>
  if (
    typeof text !== 'string' ||
    !text ||
    text.length > 800 ||
    typeof name !== 'string' ||
    !translationBodyReads.has(name) ||
    !input ||
    Array.isArray(input) ||
    typeof input !== 'object' ||
    JSON.stringify(input).length > 600 ||
    !stableRead(name, input)
  )
    return null
  return {
    text,
    name,
    input,
    ...(typeof near === 'string' &&
      near.includes(text) &&
      near.length <= text.length + 40 && { near }),
  }
}

/** Remember the locations of recent native reads. Their output stays in memory; only short
 * quoted text and its native read arguments can enter a saved conversation. */
export class TranslationReadings {
  private samples: Quotation[] = []

  record(call: AgentToolCall, output: string) {
    if (
      !translationBodyReads.has(call.name) ||
      !stableRead(call.name, call.input) ||
      JSON.stringify(call.input).length > 600
    )
      return
    const input =
      call.name === 'read_source_units' ? { ...call.input, remaining: false } : call.input
    this.samples.push({
      name: call.name,
      input,
      text: output.length < 25_000 ? output : output.slice(0, 24_000) + '\n' + output.slice(-1_000),
    })
    if (this.samples.length > 16) this.samples.splice(1, 1)
  }

  locate(text: string, target = false): Quotation | null {
    if (!text) return null
    for (const read of [...this.samples].reverse()) {
      const position = read.text.indexOf(text)
      if (position < 0) continue
      if (!target) return { text, name: read.name, input: read.input }
      // Bind a translated example to its visible slot in this read. A repeated value
      // calls for a narrower native read (one cell, block, or shape) before recording it.
      if (read.text.indexOf(text, position + text.length) >= 0) continue
      const before =
        read.text
          .slice(Math.max(0, position - 20), position)
          .split('\n')
          .at(-1) ?? ''
      const after =
        read.text.slice(position + text.length, position + text.length + 20).split('\n')[0] ?? ''
      return { text, name: read.name, input: read.input, near: before + text + after }
    }
    return null
  }
}

/** Re-read locations through the editor's own redaction, policy and range checks. Deduplicate
 * within this lookup only: Undo or manual editing can change the next lookup. */
export function checkQuotations(editor: AgentSkill, current: () => boolean, signal?: AbortSignal) {
  const reads = new Map<string, string>()
  return async (quote: Quotation | null) => {
    if (
      !quote ||
      !current() ||
      signal?.aborted ||
      !translationBodyReads.has(quote.name) ||
      !editor.tools.some((t) => t.name === quote.name)
    )
      return false
    const key = JSON.stringify([quote.name, quote.input])
    let output = reads.get(key)
    if (output === undefined) {
      if (reads.size >= 12) return false
      try {
        const read = await editor.executeTool(
          { id: 'verify-translation-quote', name: quote.name, input: quote.input },
          signal,
        )
        output = read.isError ? '' : read.output
      } catch {
        output = ''
      }
      reads.set(key, output)
    }
    return current() && !signal?.aborted && output.includes(quote.near ?? quote.text)
  }
}
