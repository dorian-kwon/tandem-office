import { Mark, type Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { Group } from './translate-runs'

/**
 * Translating a paragraph of mixed formatting as one sentence.
 *
 * Run by run, a sentence is cut where its formatting changes and each piece is translated apart,
 * so the words come out differently than they would in one go. Here the paragraph is shown to the
 * model whole, with a numbered tag around each stretch of one formatting
 * (`<1>plain </1><2>bold</2><1> plain</1>`), and the translation comes back with the same tags
 * around the words that correspond, wherever they stand in the sentence. The tag number stands
 * for the whole formatting of the original run (every mark, the raw run properties included): the
 * app puts it back, the model never writes any formatting, it only moves tags.
 *
 * Only a paragraph that is plain text from its first translatable run to its last gets tags: a
 * tab, a line break, a footnote reference, a field or a pending deletion among the runs keeps the
 * run-by-run way, where those stay exactly where they are.
 */

export interface TaggedView {
  /** the document range the tagged text covers (first group start to last group end) */
  from: number
  to: number
  /** the paragraph text with a numbered tag around each stretch of one formatting */
  tagged: string
  /** what each tag number means, in words the model can read */
  tags: Record<string, string>
  /** the marks of tag N, at index N-1 */
  formats: readonly (readonly Mark[])[]
}

/** the formatting of a run in words: "bold", "italic, 9pt", "color #C00000" */
export function describeFormat(marks: readonly Mark[]): string {
  const parts: string[] = []
  for (const mark of marks) {
    const a = mark.attrs as Record<string, unknown>
    switch (mark.type.name) {
      case 'bold':
        parts.push('bold')
        break
      case 'italic':
        parts.push('italic')
        break
      case 'underline':
        parts.push('underline')
        break
      case 'strike':
        parts.push('strikethrough')
        break
      case 'link':
        parts.push('link')
        break
      case 'comment':
        parts.push('commented')
        break
      case 'docTextStyle': {
        if (typeof a.sizeHalfPoints === 'number') parts.push(`${a.sizeHalfPoints / 2}pt`)
        if (typeof a.color === 'string') parts.push(`color #${a.color}`)
        if (typeof a.font === 'string') parts.push(`font ${a.font}`)
        if (typeof a.highlight === 'string') parts.push('highlighted')
        if (a.vertAlign === 'superscript' || a.vertAlign === 'subscript') parts.push(a.vertAlign)
        if (a.caps === 'all') parts.push('all caps')
        if (a.caps === 'small') parts.push('small caps')
        break
      }
      default:
        break
    }
  }
  return parts.length > 0 ? parts.join(', ') : 'regular'
}

/**
 * The tagged text of a textblock, or null when it does not qualify: fewer than two distinct
 * formattings, or anything but plain text between its first and last translatable run.
 */
export function taggedViewOf(
  block: ProseMirrorNode,
  pos: number,
  groups: readonly Group[],
  isFixed: (node: ProseMirrorNode) => boolean,
): TaggedView | null {
  if (groups.length < 2) return null
  const from = groups[0].from
  const to = groups[groups.length - 1].to
  const start = from - pos - 1
  const end = to - pos - 1
  const parts: Array<{ format: number; text: string }> = []
  const formats: (readonly Mark[])[] = []
  let ok = true
  block.forEach((child, offset) => {
    if (!ok) return
    const childEnd = offset + child.nodeSize
    if (childEnd <= start || offset >= end) return
    const text = child.text ?? ''
    if (
      offset < start ||
      childEnd > end ||
      !child.isText ||
      isFixed(child) ||
      /[\t\r\n]/.test(text)
    ) {
      ok = false
      return
    }
    if (text.trim() === '') {
      // a blank run belongs to the words before it
      if (parts.length === 0) ok = false
      else parts[parts.length - 1].text += text
      return
    }
    let format = formats.findIndex((f) => Mark.sameSet(f, child.marks))
    if (format < 0) {
      formats.push(child.marks)
      format = formats.length - 1
    }
    const last = parts[parts.length - 1]
    if (last && last.format === format) last.text += text
    else parts.push({ format, text })
  })
  if (!ok || formats.length < 2) return null
  const tags: Record<string, string> = {}
  const seen = new Map<string, number>()
  formats.forEach((marks, i) => {
    const label = describeFormat(marks)
    const n = (seen.get(label) ?? 0) + 1
    seen.set(label, n)
    // two formattings that read the same (they differ in settings only): told apart
    tags[String(i + 1)] = n === 1 ? label : `${label} (variant ${n})`
  })
  return {
    from,
    to,
    tagged: parts.map((p) => `<${p.format + 1}>${p.text}</${p.format + 1}>`).join(''),
    tags,
    formats,
  }
}

export type TaggedParse =
  { ok: true; pieces: Array<{ format: number; text: string }> } | { ok: false; error: string }

const TAG = /<(\/?)(\d+)>/g

/**
 * The pieces of a translation written with numbered tags: each is a text and the index of the
 * formatting it takes. Tags may nest (the inner one wins) and a number may be used any number of
 * times or not at all. Words outside every tag take the formatting of the words before them
 * (the first words, of the ones after).
 */
export function parseTagged(text: string, formatCount: number): TaggedParse {
  const raw: Array<{ format: number; text: string }> = []
  const stack: number[] = []
  let last = 0
  const push = (chunk: string) => {
    if (chunk === '') return
    const format = stack.length > 0 ? stack[stack.length - 1] : -1
    const prev = raw[raw.length - 1]
    if (prev && prev.format === format) prev.text += chunk
    else raw.push({ format, text: chunk })
  }
  for (const m of text.matchAll(TAG)) {
    push(text.slice(last, m.index))
    last = m.index + m[0].length
    const n = Number(m[2])
    if (n < 1 || n > formatCount)
      return {
        ok: false,
        error: `tag ${n} does not exist (this paragraph has tags 1 to ${formatCount}); use only the numbers read_runs gave`,
      }
    if (m[1] === '') stack.push(n - 1)
    else if (stack.pop() !== n - 1)
      return {
        ok: false,
        error: `tag ${n} is closed out of order; tags must nest, and each one is closed by its own number`,
      }
  }
  push(text.slice(last))
  if (stack.length > 0)
    return { ok: false, error: `tag ${stack[stack.length - 1] + 1} is never closed` }
  const firstTagged = raw.find((p) => p.format >= 0)
  if (!firstTagged)
    return {
      ok: false,
      error: 'the translation has no numbered tags; keep each translated word inside its tag',
    }
  let carry = firstTagged.format
  const pieces: Array<{ format: number; text: string }> = []
  for (const p of raw) {
    const format = p.format >= 0 ? p.format : carry
    carry = format
    const prev = pieces[pieces.length - 1]
    if (prev && prev.format === format) prev.text += p.text
    else pieces.push({ format, text: p.text })
  }
  if (pieces.every((p) => p.text.trim() === ''))
    return {
      ok: false,
      error: "every piece is empty, which would delete the paragraph's text; give the translation",
    }
  return { ok: true, pieces }
}
