import type { Editor } from '@tiptap/core'
import type { WordBoxTarget } from '@genoffice/project-store/editor-run'
import { blockRangePositions } from './ai/doc-utils'
import { navigateToBlock } from './ai/doc-nav'

/** Request/reply the shell relays from `genoffice open --block` and `genoffice selection`. */
export type ControlRequest =
  | {
      cmd: 'goto'
      target: { kind: string; block?: number; textBox?: WordBoxTarget & { text: string } }
    }
  | { cmd: 'selection' }

export type ControlReply =
  | { status: 'ok'; result: Record<string, unknown> }
  | { status: 'not_ready' }
  | {
      status: 'error'
      error: { reason: string; message: string; detail?: Record<string, unknown> }
    }

export function handleDocsControl(
  req: ControlRequest,
  editor: Editor | null,
  loaded: boolean,
): ControlReply {
  if (!editor || !loaded) return { status: 'not_ready' }
  const doc = editor.state.doc
  if (req.cmd === 'selection') {
    const { from, to, empty } = editor.state.selection
    const lastIndex = doc.childCount - 1
    // a caret after the last node resolves to childCount; `to` is exclusive, so a
    // whole-paragraph selection ends on the next block's boundary
    const first = Math.min(doc.resolve(from).index(0), lastIndex)
    const last = empty ? first : Math.min(doc.resolve(Math.max(from, to - 1)).index(0), lastIndex)
    return {
      status: 'ok',
      result: {
        blocks: [first, Math.max(first, last)],
        text: empty ? '' : doc.textBetween(from, to, '\n'),
        collapsed: empty,
      },
    }
  }
  const { block } = req.target
  if (block === undefined || !Number.isInteger(block) || block < 0 || block >= doc.childCount) {
    return {
      status: 'error',
      error: {
        reason: 'out_of_range',
        message: `block ${block} is out of range (the document has ${doc.childCount} blocks)`,
        detail: { valid_range: `0-${doc.childCount - 1}` },
      },
    }
  }
  navigateToBlock(editor, block)
  const target = req.target.textBox
  if (target) {
    const pos = target.cellPos ?? blockRangePositions(editor, block, block).from
    if (
      Number.isSafeInteger(pos) &&
      pos >= 0 &&
      pos < doc.content.size &&
      doc.resolve(pos).index(0) === block
    ) {
      const node = doc.nodeAt(pos)
      const host = editor.view.nodeDOM(pos)
      if (
        node?.type.name === (target.cellPos === undefined ? 'docProtected' : 'docCellBoxes') &&
        host instanceof HTMLElement
      ) {
        const box = host.querySelectorAll<HTMLElement>('.doc-textbox')[target.box]
        if (box?.textContent?.trim().startsWith(target.text)) {
          box.scrollIntoView({ block: 'center', inline: 'nearest' })
          box.animate?.(
            [{ outline: '3px solid Highlight' }, { outline: '3px solid Highlight' }],
            1600,
          )
          return { status: 'ok', result: { block, box: target.box } }
        }
      }
    }
    // The saved report can outlive later edits; leave the containing block visible.
    return {
      status: 'error',
      error: { reason: 'target_not_found', message: 'The reviewed text box has changed.' },
    }
  }
  return { status: 'ok', result: { block, type: doc.child(block).type.name } }
}
