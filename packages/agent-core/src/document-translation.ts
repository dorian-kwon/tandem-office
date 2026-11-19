import {
  asQuotation,
  checkQuotations,
  TranslationReadings,
  translationBodyReads as bodyReads,
  type Quotation,
} from './translation-evidence'
import type { AgentSkill } from './skill'
import type { AgentToolDef, ToolExecution } from './types'

/** A renderer-local identity. Never include it in a provider request. */
export interface DocumentTranslationHost {
  documentKey(): string | null | undefined
  inPlaceOnly?: boolean
  analyzingLabel(): string
}

const START = 'prepare_document_translation'
const OVERVIEW = 'record_source_overview'
const BATCH = 'translation_batch_context'

const navigation = new Set([
  'get_outline',
  'get_workbook_context',
  'get_document_context',
  'read_book',
])
const string = (description: string) => ({ type: 'string', description })
const tool = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): AgentToolDef => ({ name, description, inputSchema: { type: 'object', properties, required } })

const start = tool(
  START,
  'Start or resume translating the entire current document. Reuses its source overview. Do not call for a selection or a sentence revision.',
  {
    targetLanguage: string('Target language; reuse its name when resuming.'),
    refresh: {
      type: 'boolean',
      description:
        'True only if the person explicitly asks to reassess the source overview. Do not refresh for a sentence correction.',
    },
  },
  ['targetLanguage'],
)
const overview = tool(
  OVERVIEW,
  'Finish source analysis after surveying the sections and reading representative passages. The overview is working context only.',
  {
    overview: string(
      'Document type, subject, structure, tone and recurring terminology grounded in the text. Exclude inferred readers or purpose.',
    ),
    evidence: string('A distinctive verbatim excerpt from a body read supporting the overview.'),
    otherEvidence: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Up to two distinctive short quotes from different parts of a longer source. These let a later edit to one sentence preserve the overview.',
    },
    audienceQuote: string(
      'Optional verbatim source words explicitly identifying the intended readers. Omit when unstated.',
    ),
    purposeQuote: string(
      'Optional verbatim source words explicitly stating the purpose. Omit when unstated.',
    ),
  },
  ['overview', 'evidence'],
)
const batch = tool(
  BATCH,
  'Before each translation batch, retrieve the previous batch and earlier repeated wording. Supply new pairs only for translations actually applied. Project instructions, the current source and the person’s corrections take precedence.',
  {
    source: string('Text from the upcoming batch to match against earlier source phrases.'),
    previous: string('Optional short final translated passage from the last completed batch.'),
    pairs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          source: string('Recurring source phrase.'),
          target: string('Its actual translation.'),
        },
        required: ['source', 'target'],
      },
    },
  },
  ['source'],
)

function short(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : ''
}

const workflow =
  'A single selection, sentence revision or unrelated task uses the ordinary editor tools. ' +
  'In a bilingual layout identify the source and target slots first. Keep source text and layout intact, and edit only the requested targets. Never insert the analysis, reference excerpts or batch notes into document content.'

export interface StoredTranslationTurn {
  role: string
  tools?:
    | readonly { name: string; isError?: boolean | undefined; output?: string | undefined }[]
    | undefined
}

/** Only local tool records carry the document identifier; never include it in model messages. */
async function scopeDigest(key: string | null | undefined) {
  if (!key || !globalThis.crypto?.subtle) return ''
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
}

export function documentTranslationSkill(editor: AgentSkill, host: DocumentTranslationHost) {
  let key = host.documentKey()
  let phase: 'idle' | 'reading' | 'translating' = 'idle'
  let notes = ''
  let targetLanguage = ''
  let previous: Quotation | null = null
  let anchors: Quotation[] = []
  const pairs = new Map<string, Quotation>()
  let readings = new TranslationReadings()
  let restored: readonly StoredTranslationTurn[] = []
  let digest = ''
  let interrupted = false

  function reset() {
    phase = 'idle'
    notes = ''
    anchors = []
    targetLanguage = ''
    previous = null
    pairs.clear()
    readings = new TranslationReadings()
    key = host.documentKey()
    restored = []
    digest = ''
    interrupted = false
  }
  function checkDocument() {
    if (host.documentKey() !== key) {
      const wasActive = phase !== 'idle'
      reset()
      interrupted = wasActive
    }
  }
  const answer = (output: string, summary: string, isError = false): ToolExecution => ({
    output,
    summary,
    ...(isError && { isError: true }),
  })
  function cacheOutput(result: ToolExecution, fields: Record<string, unknown>): ToolExecution {
    if (!digest) return result
    const output = JSON.stringify({ doc: digest, ...fields })
    // Editors cap saved tool output at 2000 characters. Never persist a partial JSON record.
    return output.length < 1900 ? { ...result, historyOutput: output } : result
  }
  function recover(language: string) {
    for (const turn of restored) {
      if (turn.role !== 'assistant') continue
      for (const entry of turn.tools ?? []) {
        if (entry.isError || !entry.output || (entry.name !== OVERVIEW && entry.name !== BATCH))
          continue
        try {
          const record = JSON.parse(entry.output)
          if (!digest || record?.doc !== digest) continue
          if (entry.name === OVERVIEW) {
            notes = short(record.notes, 1700)
            anchors = (Array.isArray(record.anchors) ? record.anchors : [])
              .map(asQuotation)
              .filter((q: Quotation | null): q is Quotation => !!q)
              .slice(0, 5)
            pairs.clear()
            previous = null
          }
          if (entry.name === BATCH && record.language === language) {
            if (record.previous) previous = asQuotation(record.previous)
            for (const pair of Array.isArray(record.pairs) ? record.pairs : []) {
              if (!Array.isArray(pair)) continue
              const src = short(pair[0], 250),
                quote = asQuotation(pair[1])
              if (src && quote) pairs.set(src, quote)
              if (pairs.size > 1024) pairs.delete(pairs.keys().next().value!)
            }
          }
        } catch {
          /* Old, truncated, or different tool output. */
        }
      }
    }
    restored = []
  }
  const sourcePrompt =
    'Survey the structure, then use the native body-reading tools on representative passages across the beginning, middle and end, including tables and captions where relevant. In workbooks pass the explicit sheetId on each read so the location survives a change of active sheet. Read further until the overview is grounded. Record it before writing translations.'
  const translatingPrompt =
    'Read current source units in order. After applying a batch, read its actual translated targets before recording its ending and repeated phrases; for facing columns or rows use the translated side. On resume re-read the document and earlier targets where needed to honor manual corrections and Undo. Earlier wording is a suggestion; current project instructions and the actual document take precedence. Call translation_batch_context with upcoming source text before translating each batch. Record actual earlier wording as short source/target pairs and the previous batch ending. Use the editorial tools for the requested translated text and keep existing formatting.'
  const skill: AgentSkill = {
    id: editor.id,
    get systemPrompt() {
      checkDocument()
      const stage =
        phase === 'reading' ? sourcePrompt : phase === 'translating' ? translatingPrompt : ''
      const route = host.inPlaceOnly
        ? 'Use the dedicated translation job for a translated copy of the book or PDF. Only when the person explicitly requests in-place translation of the whole current file, or resumption of that same edit, call prepare_document_translation first.'
        : 'When the person asks to translate the entire open document, workbook, deck or map, or to resume that work, call prepare_document_translation first.'
      return [editor.systemPrompt, route, workflow, stage].filter(Boolean).join('\n\n')
    },
    get tools() {
      checkDocument()
      if (interrupted) return []
      if (phase === 'reading')
        return [
          ...editor.tools.filter((t) => navigation.has(t.name) || bodyReads.has(t.name)),
          overview,
        ]
      return phase === 'translating' ? [...editor.tools, batch] : [...editor.tools, start]
    },
    buildContext() {
      checkDocument()
      phase = 'idle'
      interrupted = false
      readings = new TranslationReadings()
      return editor.buildContext?.() ?? ''
    },
    async executeTool(call, signal) {
      checkDocument()
      if (phase === 'idle' && call.name !== START && !interrupted)
        return editor.executeTool(call, signal)
      const label = host.analyzingLabel()
      const input = call.input
      const requestKey = key
      const current = () =>
        key === requestKey && host.documentKey() === requestKey && !signal?.aborted
      const verify = checkQuotations(editor, current, signal)
      if (interrupted)
        return answer(
          'The active document changed. Start the request again on the intended document.',
          label,
          true,
        )
      if (call.name === START && phase === 'idle') {
        const target = short(input.targetLanguage, 100).toLowerCase()
        if (!target) return answer('Specify the target language.', label, true)
        if (target !== targetLanguage) {
          previous = null
          pairs.clear()
          targetLanguage = target
        }
        const originalKey = key
        const scope = digest || (await scopeDigest(key))
        if (signal?.aborted || originalKey !== host.documentKey())
          return answer('The source document changed or the request stopped.', label, true)
        digest = scope
        recover(target)
        const stillPresent = new Set<string>()
        if (notes && input.refresh !== true) {
          for (const anchor of anchors) {
            // An in-place translation may have replaced the original at this location.
            const translated = pairs.get(anchor.text)
            const sameLocation =
              translated?.name === anchor.name &&
              JSON.stringify(translated.input) === JSON.stringify(anchor.input)
            if ((await verify(anchor)) || (sameLocation && (await verify(translated)))) {
              stillPresent.add(anchor.text)
            }
          }
        }
        if (!current())
          return answer('The source document changed or the request stopped.', label, true)
        if (stillPresent.size) {
          // A surviving structural excerpt can keep the overview even if a sentence changed.
          // Remove source claims whose supporting passage has disappeared or been redacted.
          notes = notes
            .split('\n')
            .filter((line) => {
              const match = /^(?:Evidence|Readers|Purpose): (.*)$/u.exec(line)
              return !match || [...stillPresent].some((quote) => JSON.stringify(quote) === match[1])
            })
            .join('\n')
          if (!notes.includes('\nEvidence: '))
            notes += '\nEvidence: ' + JSON.stringify([...stillPresent][0])
        } else {
          anchors = []
          notes = ''
          pairs.clear()
          previous = null
        }
        phase = notes ? 'translating' : 'reading'
        return answer(
          notes ? 'Existing source overview (reference material):\n' + notes : sourcePrompt,
          notes || label,
        )
      }
      if (phase === 'reading') {
        if (call.name === OVERVIEW) {
          const summary = short(input.overview, 700)
          const quote = short(input.evidence, 300)
          const audience = short(input.audienceQuote, 300)
          const purpose = short(input.purposeQuote, 300)
          const more = Array.isArray(input.otherEvidence)
            ? input.otherEvidence
                .slice(0, 2)
                .map((q) => short(q, 100))
                .filter(Boolean)
            : []
          const quotes = [quote, ...more, audience, purpose].filter(Boolean)
          const found = quotes.map((q) => readings.locate(q))
          if (!summary || !quote || found.some((q) => !q))
            return answer(
              'Read the source body first. Use explicit sheet IDs in a workbook, cite exact text for the overview and omit unstated audience or purpose.',
              label,
              true,
            )
          notes = [
            summary,
            'Evidence: ' + JSON.stringify(quote),
            audience && 'Readers: ' + JSON.stringify(audience),
            purpose && 'Purpose: ' + JSON.stringify(purpose),
          ]
            .filter(Boolean)
            .join('\n')
          anchors = found.filter((q): q is Quotation => !!q)
          phase = 'translating'
          const savedAnchors = [...anchors]
          while (
            savedAnchors.length > 1 &&
            JSON.stringify({ doc: digest, notes, anchors: savedAnchors }).length >= 1900
          )
            savedAnchors.pop()
          return cacheOutput(answer(translatingPrompt, summary), { notes, anchors: savedAnchors })
        }
        if (!navigation.has(call.name) && !bodyReads.has(call.name))
          return answer('Complete the source overview before editing.', label, true)
      }
      if (bodyReads.has(call.name)) {
        const log = readings
        const result = await editor.executeTool(call, signal)
        if (current() && log === readings && !result.isError) log.record(call, result.output)
        return result
      }
      if (call.name === BATCH && phase === 'translating') {
        const ending = short(input.previous, 800)
        if (ending) previous = readings.locate(ending, true)
        const added: [string, Quotation][] = []
        for (const pair of Array.isArray(input.pairs) ? input.pairs.slice(0, 32) : []) {
          const source = short(pair?.source, 250),
            target = short(pair?.target, 250)
          const at = readings.locate(target, true)
          if (readings.locate(source) && at && (await verify(at))) {
            pairs.set(source, at)
            added.push([source, at])
            if (pairs.size > 1024) pairs.delete(pairs.keys().next().value!)
          }
        }
        const text = short(input.source, 12_000).normalize('NFC').toLowerCase()
        const matches: [string, string][] = []
        for (const [source, quotation] of pairs) {
          if (text.includes(source.normalize('NFC').toLowerCase()) && (await verify(quotation)))
            matches.push([source, quotation.text])
          if (matches.length === 16) break
        }
        const prior = (await verify(previous)) ? previous?.text : ''
        if (!current())
          return answer('The source document changed or the request stopped.', label, true)
        const result = answer(
          JSON.stringify({ overview: notes, previous: prior, matches }),
          ending || short(input.source, 80) || label,
        )
        // Keep as many exact pairs as fit alongside the previous ending in the stored tool record.
        while (
          added.length &&
          JSON.stringify(added).length + JSON.stringify(previous).length > 1550
        )
          added.pop()
        return cacheOutput(result, {
          language: targetLanguage,
          ...(ending && { previous }),
          pairs: added,
        })
      }
      return editor.executeTool(call, signal)
    },
    ...(editor.verifyResponse && { verifyResponse: editor.verifyResponse.bind(editor) }),
  }
  return {
    skill,
    reset,
    restore(turns: readonly StoredTranslationTurn[]) {
      restored = turns
    },
  }
}
