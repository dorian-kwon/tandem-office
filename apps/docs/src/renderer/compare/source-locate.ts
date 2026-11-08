/**
 * The Korean original of a selection in a translated document. The output copy
 * of a translation project has the same block structure as its source copy, so
 * the paragraphs the selection touches are found by position: top-level block
 * index plus the ordinal of the text block inside it (a table cell paragraph is
 * the n-th text block of its table). Pure over ProseMirror nodes; the bytes of
 * the source copy come from the main process.
 */
import type { Editor } from '@tiptap/core'
import type { Node as PmNodeType } from '@tiptap/pm/model'
import { readSections } from '@genoffice/docx-engine'
import type { CompareSourceBytes } from '../../shared/compare'
import { blocksToPmDoc, pmDocOptions } from '../editor/convert'
import { parseDocxOffThread } from '../parse-off-thread'

export interface BlockPosition {
  /** top-level block index */
  index: number
  /** which text block of that block, in document order */
  ordinal: number
}

/** the most paragraphs one selection may map to (a longer one is entered by hand) */
export const LOCATE_MAX_PARAGRAPHS = 40

/** the text blocks of a top-level block, in order (the block itself when it is one) */
function textBlocksOf(block: PmNodeType): PmNodeType[] {
  if (block.isTextblock) return [block]
  const found: PmNodeType[] = []
  block.descendants((node) => {
    if (node.isTextblock) {
      found.push(node)
      return false
    }
    return true
  })
  return found
}

/** the paragraphs of `doc` that `from..to` touches, as positions */
export function locateRange(doc: PmNodeType, from: number, to: number): BlockPosition[] {
  const out: BlockPosition[] = []
  doc.forEach((block, start, index) => {
    if (start + block.nodeSize <= from || start >= to) return
    if (block.isTextblock) {
      out.push({ index, ordinal: 0 })
      return
    }
    let ordinal = 0
    block.descendants((node, pos) => {
      if (!node.isTextblock) return true
      const nodeStart = start + 1 + pos
      if (nodeStart + node.nodeSize > from && nodeStart < to) out.push({ index, ordinal })
      ordinal++
      return false
    })
  })
  return out
}

/** the text at the given positions of another document, joined by line breaks */
export function textAt(doc: PmNodeType, positions: readonly BlockPosition[]): string | null {
  const lines: string[] = []
  for (const { index, ordinal } of positions) {
    if (index >= doc.childCount) return null
    const block = textBlocksOf(doc.child(index))[ordinal]
    if (!block) return null
    const text = block.textContent.trim()
    if (text) lines.push(text)
  }
  return lines.length > 0 ? lines.join('\n') : null
}

/** the source copy's paragraphs for a selection of the output copy; null when it cannot be told */
export function sourceTextFor(
  outputDoc: PmNodeType,
  sourceDoc: PmNodeType,
  from: number,
  to: number,
): string | null {
  // a different block count means the structure drifted: do not guess
  if (outputDoc.childCount !== sourceDoc.childCount) return null
  const positions = locateRange(outputDoc, from, to)
  if (positions.length === 0 || positions.length > LOCATE_MAX_PARAGRAPHS) return null
  return textAt(sourceDoc, positions)
}

/** the Korean original of the selection, read from the project's source copy; null falls back to manual entry */
export async function readKoreanSource(
  editor: Editor,
  range: { from: number; to: number },
  readSource: (() => Promise<CompareSourceBytes>) | undefined,
): Promise<string | null> {
  if (!readSource) return null
  try {
    const result = await readSource()
    if (!result.ok) return null
    const parsed = await parseDocxOffThread(result.bytes, { owned: true })
    const json = blocksToPmDoc(parsed.blocks, readSections(parsed), pmDocOptions(parsed))
    const sourceDoc = editor.schema.nodeFromJSON(json)
    return sourceTextFor(editor.state.doc, sourceDoc, range.from, range.to)
  } catch {
    return null
  }
}
