import type { Editor } from '@tiptap/core'
import type { Node } from '@tiptap/pm/model'
import { Step, StepResult } from '@tiptap/pm/transform'
import type { HeaderFooter, Run } from '@genoffice/docx-engine'
import { hfParasOf } from '../editor/hf-text'
import type { HfView } from '../doc-state'
import { editKey, ownHf, type HfKind, type HfSectionState } from '../hf-sections'
import { originalAiEditor } from './ai-history-gate'
import { runFingerprint } from './run-fingerprint'

type Story = {
  nativeXml?: boolean
  id: string
  value: HeaderFooter
  owner: number
  kind: HfKind
  view: HfView
}
export interface AiHfStoryAccess {
  list(): Story[]
  writable(): boolean
  set(story: Story, next: HeaderFooter): void
}

const storyCache = new WeakMap<HfSectionState, Story[]>()

/** Walk only owning references. Inherited sections and variants can point to the same physical part. */
export function hfStories(state: HfSectionState): Story[] {
  const cached = storyCache.get(state)
  if (cached) return cached
  const pending = new Set(Object.values(state.edits))
  const stories = new Map<string, Story>()
  for (let owner = 0; owner < state.sections.length; owner++) {
    const section = state.sections[owner]!
    for (const kind of ['header', 'footer'] as const) {
      for (const view of ['default', 'first', 'even'] as const) {
        const rid = (kind === 'header' ? section.headerRefs : section.footerRefs)[view]
        const key = rid ?? editKey(section.lastBlockIndex, kind, view)
        if (stories.has(key)) continue
        const resolved = ownHf(state, owner, kind, view)
        if (resolved?.value)
          stories.set(key, {
            id: `${kind}:${view}:${key}`,
            owner,
            kind,
            view,
            value: resolved.value,
            nativeXml:
              !resolved.value.revisionsResolved?.length &&
              (resolved.value.translationText
                ? resolved.value.translationText.paras === resolved.value.paras
                : !pending.has(resolved.value)),
          })
      }
    }
  }
  const result = [...stories.values()]
  storyCache.set(state, result)
  return result
}

type Slot = { protected?: boolean; block: number; cell?: number; line?: number; runs: Run[] }
function slots(value: HeaderFooter): Slot[] {
  const out: Slot[] = []
  hfParasOf(value).forEach((p, block) => {
    if (p.lineOnly) return
    if (!p.cells) out.push({ block, runs: p.runs, protected: !!(p.box || p.boxAnchored) })
    else
      p.cells.forEach((c, cell) => {
        if (!c.vMergeContinue)
          c.paras.forEach((runs, line) =>
            out.push({ block, cell, line, runs, protected: c.locked }),
          )
      })
  })
  return out
}

// Fields, tabs and line breaks occupy positions in the strip but are not translated.
const delimiters = /([\t\r\n\uE000-\uE002])/
const isText = (t: string) => t.trim() !== '' && !delimiters.test(t)
type Fragment = { index?: number; text: string; editable: boolean }
function fragments(run: Run): Fragment[] {
  if (
    run.refField ||
    run.instrField ||
    run.fldBeginXml ||
    run.zoteroFieldId !== undefined ||
    run.del ||
    run.sym
  )
    return [{ text: run.text, editable: false }]
  if (run.hfTextLeaves && run.hfTextLeaves.map((l) => l.text).join('') === run.text)
    return run.hfTextLeaves.map((l) => ({ ...l, editable: l.index >= 0 && isText(l.text) }))
  return run.text.split(delimiters).map((text) => ({ text, editable: isText(text) }))
}
const segmentsOf = (runs: Run[]) =>
  runs.flatMap((r) =>
    fragments(r)
      .filter((f) => f.editable)
      .map((f) => f.text),
  )
const canPatch = (runs: Run[]) =>
  runs.every((r) => fragments(r).every((f) => !f.editable || f.index !== undefined))
export function readHfStoryRuns(access: AiHfStoryAccess) {
  return access.list().flatMap((s) =>
    slots(s.value).flatMap(({ runs, protected: locked }, paragraph) => {
      const segments = segmentsOf(runs)
      return segments.length
        ? [
            {
              story: s.id,
              paragraph,
              fp: runFingerprint(segments),
              segments,
              ...(locked && !(s.nativeXml && canPatch(runs)) ? { readOnly: true } : {}),
            },
          ]
        : []
    }),
  )
}

function replaceSlot(story: Story, slot: Slot, runs: Run[]): HeaderFooter {
  const value = story.value
  const paras = hfParasOf(value).slice()
  const p = { ...paras[slot.block]! }
  paras[slot.block] = p
  if (slot.cell === undefined) p.runs = runs
  else {
    const cells = p.cells!.slice()
    const cell = { ...cells[slot.cell]!, rewrite: true as const }
    cell.paras = cell.paras.slice()
    cell.paras[slot.line!] = runs
    cells[slot.cell] = cell
    p.cells = cells
  }
  const text = paras
    .filter((p) => !p.cells)
    .map((p) => p.runs.map((r) => r.text).join(''))
    .join('')
  let translationText: HeaderFooter['translationText']
  if (story.nativeXml && canPatch(runs)) {
    const values = { ...value.translationText?.values }
    runs.forEach((r, i) => {
      const before = fragments(slot.runs[i]!)
      fragments(r).forEach((f, j) => {
        if (f.index !== undefined && f.index >= 0 && f.text !== before[j]?.text)
          values[f.index] = f.text
      })
    })
    translationText = { paras, values }
  }
  return { ...value, text, paras, translationText, pictureOnly: false, keepContent: undefined }
}
export interface HfItem {
  story: string
  paragraph: number
  fp: string
  segments: string[]
  afterBody: number
}
type HfChange = { item: HfItem; before: Run[]; after: Run[] }
class StoryStep extends Step {
  constructor(
    readonly access: AiHfStoryAccess,
    readonly change: HfChange,
  ) {
    super()
  }
  apply(doc: Node) {
    return StepResult.ok(doc)
  }
  map() {
    return this
  }
  invert() {
    return new StoryStep(this.access, {
      ...this.change,
      before: this.change.after,
      after: this.change.before,
    })
  }
  toJSON() {
    return { stepType: 'localHeaderFooterTranslation' }
  }
  commit() {
    const { item, before, after } = this.change
    const story = this.access.list().find((s) => s.id === item.story)
    if (!story) return
    const slot = slots(story.value)[item.paragraph]
    if (!slot || (slot.runs !== before && JSON.stringify(slot.runs) !== JSON.stringify(before)))
      return
    this.access.set(story, replaceSlot(story, slot, after))
  }
}
const observed = new WeakSet<Editor>()
export function planHfTranslations(
  editor: Editor,
  access: AiHfStoryAccess,
  items: HfItem[],
  bilingual: boolean,
) {
  const errors: string[] = [],
    stale: string[] = []
  const steps: Array<{ afterBody: number; step: Step }> = []
  const reports: Array<{
    story: string
    paragraph: number
    fp: string
    sourceSegments: string[]
    sourceFp: string
    changed: boolean
  }> = []
  if (!access.writable())
    return { errors: ['Document header/footer is read-only'], stale, steps, reports }
  const stories = new Map(
    access.list().map((s) => [s.id, { slots: slots(s.value), native: s.nativeXml }]),
  )
  const seen = new Set<string>()
  for (const item of items) {
    const label = `${item.story} paragraph ${item.paragraph}`
    const state = stories.get(item.story)
    const slot = state?.slots[item.paragraph]
    if (seen.has(label)) {
      errors.push(`${label} listed twice`)
      continue
    }
    seen.add(label)
    if (!slot || runFingerprint(segmentsOf(slot.runs)) !== item.fp) {
      stale.push(label)
      continue
    }
    if (slot.protected && !(state?.native && canPatch(slot.runs))) {
      errors.push(`${label} is protected and cannot be edited safely.`)
      continue
    }
    if (item.segments.length !== segmentsOf(slot.runs).length) {
      errors.push(`${label}: pass exactly one plain-text translation for each segment`)
      continue
    }
    let i = 0
    const after = slot.runs.map((run) => {
      const parts = fragments(run).map((part) => {
        if (!part.editable) return part
        const translated = item.segments[i++]!
        const text =
          bilingual && translated && translated !== part.text
            ? `${part.text} (${translated})`
            : translated || (bilingual ? part.text : '')
        return { ...part, text }
      })
      const text = parts.map((p) => p.text).join('')
      return text === run.text
        ? run
        : {
            ...run,
            text,
            ...(run.hfTextLeaves
              ? { hfTextLeaves: parts.map((p) => ({ index: p.index ?? -1, text: p.text })) }
              : {}),
          }
    })
    const changed = after.some((r, k) => r !== slot.runs[k])
    reports.push({
      story: item.story,
      paragraph: item.paragraph,
      fp: runFingerprint(segmentsOf(after)),
      sourceSegments: segmentsOf(slot.runs),
      sourceFp: item.fp,
      changed,
    })
    if (changed)
      steps.push({
        afterBody: item.afterBody,
        step: new StoryStep(access, { item, before: slot.runs, after }),
      })
  }
  const owner = originalAiEditor(editor)
  if (steps.length && !observed.has(owner)) {
    observed.add(owner)
    owner.on('transaction', ({ transaction, appendedTransactions }) => {
      for (const tr of [transaction, ...appendedTransactions])
        for (const step of tr.steps) if (step instanceof StoryStep) step.commit()
    })
  }
  return { errors, stale, steps, reports }
}
