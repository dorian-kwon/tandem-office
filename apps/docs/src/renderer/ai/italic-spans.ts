import type { Mark, Node as ProseMirrorNode, Schema } from '@tiptap/pm/model'

/**
 * Italic spans inside a translated segment.
 *
 * A segment is plain text, but the one tag `<i>…</i>` (no attributes, no nesting) may
 * wrap a part of it. Every comparison, count, fingerprint and word diff works on the
 * PLAIN text (tags removed); the span is remembered as a range of non-whitespace
 * character ranks, which survives the whitespace settling (edge blanks, tidy spacing)
 * that runs between the model's text and the text that is written. The span is applied as
 * an ADDED italic mark on top of the marks of the run the segment belongs to; italics
 * are never removed. Nothing here ever lets a literal tag reach the document.
 */

/** `[from, to)` counted in non-whitespace characters of the plain text */
export type SpanRanks = Array<[number, number]>
/** `[from, to)` as character offsets of one text */
export type SpanOffsets = Array<[number, number]>

export interface ParsedSegment {
  plain: string
  spans: SpanRanks
}

const ITALIC_TAG = /<(\/?)i>/gi

/** why the italic tags of a segment are wrong (null: balanced and flat, or none) */
export function italicTagError(segment: string): string | null {
  let open = false
  for (const m of segment.matchAll(ITALIC_TAG)) {
    if (m[1] === '') {
      if (open) return 'nested <i> tags'
      open = true
    } else {
      if (!open) return 'a </i> without its <i>'
      open = false
    }
  }
  return open ? 'an <i> that is never closed' : null
}

/** the segment without its `<i>` and `</i>` tags */
export const stripItalicTags = (segment: string): string => segment.replace(ITALIC_TAG, '')

const countNonSpace = (text: string): number => text.replace(/\s/g, '').length

/** the plain text of a segment and its italic spans (the tags are assumed balanced) */
export function parseItalicSegment(segment: string): ParsedSegment {
  let plain = ''
  let rank = 0
  let start = -1
  const spans: SpanRanks = []
  let last = 0
  for (const m of segment.matchAll(ITALIC_TAG)) {
    const part = segment.slice(last, m.index)
    plain += part
    rank += countNonSpace(part)
    last = m.index + m[0].length
    if (m[1] === '') start = rank
    else if (start >= 0) {
      if (rank > start) {
        const prev = spans[spans.length - 1]
        if (prev && prev[1] === start) prev[1] = rank
        else spans.push([start, rank])
      }
      start = -1
    }
  }
  plain += segment.slice(last)
  return { plain, spans }
}

/** the spans of several segments that were joined (in order) into one text */
export function joinParsed(parts: readonly ParsedSegment[], plain: string): ParsedSegment {
  const spans: SpanRanks = []
  let offset = 0
  for (const part of parts) {
    for (const [a, b] of part.spans) spans.push([a + offset, b + offset])
    offset += countNonSpace(part.plain)
  }
  return { plain, spans }
}

/**
 * Where the spans of `source` (its plain text) lie in `settled`, the same words with other
 * edge or stray whitespace. Spans are dropped when the non-whitespace text differs, which
 * settling never causes.
 */
export function placeSpans(settled: string, source: ParsedSegment): SpanOffsets {
  if (source.spans.length === 0) return []
  if (settled.replace(/\s/g, '') !== source.plain.replace(/\s/g, '')) return []
  const at: number[] = []
  for (let i = 0; i < settled.length; i++) if (!/\s/.test(settled[i])) at.push(i)
  const out: SpanOffsets = []
  for (const [a, b] of source.spans) if (b > a && b <= at.length) out.push([at[a], at[b - 1] + 1])
  return out
}

/** the spans cut to `[from, to)` of the text they were placed in, as offsets inside that part */
export function sliceSpans(spans: SpanOffsets, from: number, to: number): SpanOffsets {
  const out: SpanOffsets = []
  for (const [a, b] of spans) {
    const s = Math.max(a, from)
    const e = Math.min(b, to)
    if (e > s) out.push([s - from, e - from])
  }
  return out
}

/**
 * Text nodes for `text` with `marks`; the spans get the italic mark on top of them. A run
 * that is italic already keeps its marks as they are.
 */
export function textNodes(
  schema: Schema,
  text: string,
  marks: readonly Mark[],
  spans?: SpanOffsets,
): ProseMirrorNode[] {
  const italic = schema.marks.italic
  if (!spans || spans.length === 0 || !italic) return [schema.text(text, marks)]
  const on = italic.create().addToSet(marks)
  const out: ProseMirrorNode[] = []
  let at = 0
  for (const [a, b] of spans) {
    if (a > at) out.push(schema.text(text.slice(at, a), marks))
    out.push(schema.text(text.slice(a, b), on))
    at = b
  }
  if (at < text.length) out.push(schema.text(text.slice(at), marks))
  return out
}
