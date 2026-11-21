import { MAX_CHANGE_LOCATIONS } from '@genoffice/agent-core'
import type { AgentToolCall, AgentToolDef, ToolExecution } from '@genoffice/agent-core'
import { isolateHistory } from '@codemirror/commands'
import { Transaction, type Text } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { aiEditUndoHistoryEnabled } from '@genoffice/ui'

const language = {
  type: 'string',
  description: 'Target language; reuse the same name when resuming.',
}
export const sourceTools: AgentToolDef[] = [
  {
    name: 'read_source_units',
    description:
      'Read numbered TXT lines or JSON string values. Use remaining:true when resuming. Follow next to page through the open file.',
    inputSchema: {
      type: 'object',
      properties: {
        language,
        start: { type: 'integer', minimum: 0 },
        remaining: { type: 'boolean' },
      },
      required: ['language'],
    },
  },
  {
    name: 'translate_source_units',
    description:
      'Apply an ordered batch of translations. Each unit is independently undoable. Echo the exact source from read_source_units.',
    inputSchema: {
      type: 'object',
      properties: {
        language,
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'integer' },
              source: { type: 'string' },
              translation: { type: 'string' },
            },
            required: ['id', 'source', 'translation'],
          },
        },
      },
      required: ['language', 'items'],
    },
  },
]
type Unit = { from: number; to: number; text: string }
export class SourceTranslation {
  private lastRead?: Text
  private indexed?: Text
  private units: Unit[] = []
  private counts?: { language: string; done: number; total: number }
  private completed = new Map<string, Map<number, string>>()
  constructor(
    private readonly view: EditorView,
    private readonly json: boolean,
  ) {}

  private index(): Unit[] {
    const doc = this.view.state.doc
    if (this.indexed === doc) return this.units
    const units: Unit[] = []
    if (this.json) {
      const source = doc.toString()
      JSON.parse(source)
      // The file is valid JSON. A quoted token followed by a colon is a property name.
      const strings = /"(?:\\[\s\S]|[^"\\])*"(\s*:)?/g
      for (const match of source.matchAll(strings)) {
        if (!match[1])
          units.push({
            from: match.index!,
            to: match.index! + match[0].length,
            text: JSON.parse(match[0]) as string,
          })
      }
    } else {
      for (let line = 1; line <= doc.lines; line++) {
        const { from, to, text } = doc.line(line)
        units.push({ from, to, text })
      }
    }
    this.counts = undefined
    this.indexed = doc
    this.units = units
    return units
  }

  showUnit(id: number): void {
    let unit: Unit | undefined
    try {
      unit = this.index()[id]
    } catch {
      return
    }
    if (!unit) return
    this.view.dispatch({ selection: { anchor: unit.from, head: unit.to }, scrollIntoView: true })
    this.view.focus()
  }

  execute(call: AgentToolCall): ToolExecution {
    const fail = (output: string) => ({ summary: call.name, output, isError: true })
    const lang =
      typeof call.input.language === 'string' ? call.input.language.trim().toLowerCase() : ''
    if (!lang) return fail('Specify the target language.')
    let units: Unit[]
    try {
      units = this.index()
    } catch {
      return fail(
        'The open JSON file must contain valid JSON before translating its string values.',
      )
    }
    if (
      call.name === 'translate_source_units' &&
      this.lastRead &&
      this.lastRead !== this.view.state.doc
    )
      return fail('The document changed since the last read. Read the current units and retry.')
    const completed = this.completed.get(lang) ?? new Map<number, string>()
    // Recount only after a manual document change/Undo or a target-language switch.
    if (this.counts?.language !== lang) {
      let done = 0,
        total = 0
      for (let id = 0; id < units.length; id++) {
        const text = units[id]!.text
        const handled = completed.get(id) === text
        if (handled) done++
        if (handled || text.trim()) total++
      }
      this.counts = { language: lang, done, total }
    }
    const counts = this.counts
    if (call.name === 'read_source_units') {
      const start = call.input.start ?? 0
      if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0)
        return fail('Invalid start.')
      this.lastRead = this.view.state.doc
      const page = []
      let chars = 0,
        id = start
      for (; id < units.length; id++) {
        const text = units[id]!.text
        if (!text.trim() || (call.input.remaining === true && completed.get(id) === text)) continue
        if (page.length && (page.length >= 100 || chars + text.length > 24000)) break
        chars += text.length
        page.push({ id, text })
      }
      return {
        summary: call.name,
        translationProgress: { done: counts.done, total: counts.total },
        output: JSON.stringify({ units: page, next: id < units.length ? id : null }),
      }
    }
    if (call.name !== 'translate_source_units' || !Array.isArray(call.input.items))
      return fail('Read source units and pass an items array.')
    const edits: { id: number; unit: Unit; translation: string }[] = []
    const seen = new Set<number>()
    for (const item of call.input.items) {
      if (
        !item ||
        !Number.isSafeInteger(item.id) ||
        seen.has(item.id) ||
        typeof item.translation !== 'string'
      )
        return fail('Invalid or duplicate translation unit.')
      const unit = units[item.id]
      if (!unit || unit.text !== item.source)
        return fail('The source changed. Read the current units and retry.')
      if (!this.json && /[\r\n]/.test(item.translation))
        return fail('Keep each TXT line on a single line.')
      seen.add(item.id)
      edits.push({ id: item.id, unit, translation: item.translation })
    }
    // Preserve submission order (and hence Undo order). Every transaction uses
    // the previous state's coordinates. The mounted view renders the batch once.
    let state = this.view.state
    let mapping = state.changes([])
    const transactions: Transaction[] = []
    const record = aiEditUndoHistoryEnabled()
    for (const { unit, translation } of edits) {
      if (unit.text === translation) continue
      const tr = state.update({
        changes: {
          from: mapping.mapPos(unit.from, 1),
          to: mapping.mapPos(unit.to, -1),
          insert: this.json ? JSON.stringify(translation) : translation,
        },
        annotations: [isolateHistory.of('full'), Transaction.addToHistory.of(record)],
      })
      mapping = mapping.compose(tr.changes)
      transactions.push(tr)
      state = tr.state
    }
    if (transactions.length) {
      this.view.update(transactions)
      // Translating a line or a quoted value preserves the numbering. Shift
      // the cached spans once instead of decoding the entire JSON file again
      // before the next batch. Undo and manual edits invalidate this by identity.
      const changed = new Map(edits.map((edit) => [edit.id, edit.translation]))
      let delta = 0
      this.units = units.map((unit, id) => {
        const translation = changed.get(id)
        if (translation === undefined || translation === unit.text)
          return delta ? { ...unit, from: unit.from + delta, to: unit.to + delta } : unit
        const from = unit.from + delta
        const to = from + (this.json ? JSON.stringify(translation).length : translation.length)
        delta = to - unit.to
        return { from, to, text: translation }
      })
      this.indexed = state.doc
    }
    this.lastRead = state.doc
    for (const { id, unit, translation } of edits) {
      if (completed.get(id) !== unit.text) {
        counts.done++
        if (!unit.text.trim()) counts.total++
      }
      completed.set(id, translation)
    }
    this.completed.set(lang, completed)
    return {
      summary: call.name,
      output: JSON.stringify({ handled: edits.length, changed: transactions.length }),
      mutated: transactions.length > 0,
      translationProgress: { done: counts.done, total: counts.total },
      changeLocations: edits
        .filter((edit) => edit.unit.text !== edit.translation)
        .slice(0, MAX_CHANGE_LOCATIONS)
        .map((edit) => ({ kind: 'source', index: edit.id })),
    }
  }
}
