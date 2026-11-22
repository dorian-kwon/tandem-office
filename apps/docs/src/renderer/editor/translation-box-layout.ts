import type { Editor } from '@tiptap/core'
import type { TextboxDisplay } from '@genoffice/docx-engine'

const pending = new WeakSet<HTMLElement>()

export const hasPendingTranslationBoxes = (root: HTMLElement): boolean => pending.has(root)

/** A regular save keeps authored fixed shapes intact. Translation requests opt in. */
export function prepareTranslationBoxLayout(editor: Editor): boolean {
  if (!editor.view?.dom?.querySelector('.doc-textbox')) return false
  pending.add(editor.view.dom)
  return true
}

export function clearTranslationBoxLayout(editor: Editor): void {
  if (editor.view?.dom) pending.delete(editor.view.dom)
}

interface BoxHit {
  pos: number
  attr: 'textboxes' | 'boxes'
  index: number
  box: TextboxDisplay
  el: HTMLElement
  location: string
  target: { block: number; box: number; cellPos?: number }
  below: number
  beside: number
}

function textOverflow(el: HTMLElement) {
  const rect = el.getBoundingClientRect()
  const range = document.createRange()
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let below = 0
  let beside = 0
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (!t.textContent?.trim()) continue
    range.selectNodeContents(t)
    for (const line of range.getClientRects()) {
      if (!line.width || !line.height) continue
      below = Math.max(below, line.bottom - rect.bottom, rect.top - line.top)
      beside = Math.max(beside, line.right - rect.right, rect.left - line.left)
    }
  }
  return { below, beside }
}

function clippedBoxes(editor: Editor, positions?: Set<number>): BoxHit[] {
  const hits: BoxHit[] = []
  const measureNode = (node: typeof editor.state.doc, pos: number) => {
    const attr = node.type.name === 'docCellBoxes' ? 'boxes' : 'textboxes'
    const boxes = node.attrs[attr] as TextboxDisplay[] | undefined
    if (!boxes?.length) return
    const host = editor.view.nodeDOM(pos)
    if (!(host instanceof HTMLElement)) return
    const elements = host.querySelectorAll<HTMLElement>('.doc-textbox')
    boxes.forEach((box, index) => {
      const el = elements[index]
      if (
        !el ||
        !box.heightPx ||
        !el.textContent?.trim() ||
        getComputedStyle(el).overflow !== 'hidden'
      )
        return
      const rect = el.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      const { below, beside } = textOverflow(el)
      const scale = rect.height / el.offsetHeight
      if (!(scale > 0) || Math.max(below, beside) <= 2 * scale) return
      const block = editor.state.doc.resolve(pos).index(0)
      hits.push({
        pos,
        attr,
        index,
        box,
        el,
        below: below / scale,
        beside: beside / scale,
        target: { block, box: index, ...(attr === 'boxes' ? { cellPos: pos } : {}) },
        location: `block ${block} · ${attr === 'boxes' ? 'cell @' + pos + ' · ' : ''}box ${index}`,
      })
    })
    return false
  }
  if (positions) {
    for (const pos of positions) {
      const node = editor.state.doc.nodeAt(pos)
      if (node) measureNode(node, pos)
    }
  } else {
    editor.state.doc.descendants(measureNode)
  }
  return hits
}

export function reviewTranslationBoxLayout(editor: Editor) {
  return clippedBoxes(editor).map(({ location, target, el }) => ({
    location,
    target,
    text: (el.textContent ?? '').trim().slice(0, 180),
  }))
}

// Grow only into vacant space inside an existing reserved drawing band. Keeping
// its bounds fixed also keeps the following body paragraphs and pages in place.
function growIntoBand(hit: BoxHit, planned: Map<Element, DOMRect>): TextboxDisplay | undefined {
  const { box, el, below, beside } = hit
  const host = el.parentElement
  if (
    !host?.dataset.band ||
    box.rotDeg ||
    box.pagePinned ||
    box.pageRelV ||
    !box.heightPx ||
    !box.widthPx ||
    box.fillImageDataUrl
  )
    return
  const r = el.getBoundingClientRect()
  const scale = r.height / el.offsetHeight
  const band = host.getBoundingClientRect()
  let bottom = band.bottom
  let right = band.right
  for (const child of host.children) {
    if (child === el) continue
    const other = planned.get(child) ?? child.getBoundingClientRect()
    if (!other.width || !other.height) continue
    if (other.left < r.right && r.left < other.right && other.bottom > r.bottom)
      bottom = Math.min(bottom, other.top)
    if (other.top < r.bottom && r.top < other.bottom && other.right > r.right)
      right = Math.min(right, other.left)
  }
  const extra = Math.ceil(below) + 2
  if (beside <= 2 && r.bottom + extra * scale <= bottom) {
    planned.set(el, new DOMRect(r.x, r.y, r.width, r.height + extra * scale))
    return { ...box, heightPx: box.heightPx + extra }
  }
  // Probe the actual wrapping at the available width, then keep the narrowest
  // whole-pixel width that fits. Only this absolutely positioned box reflows.
  if (getComputedStyle(el).position !== 'absolute') return
  let low = Math.ceil(box.widthPx) + 1
  let high = Math.floor(box.widthPx + (right - r.right) / scale)
  if (high < low) return
  const width = el.style.width
  const fits = (w: number) => {
    el.style.width = w + 'px'
    const overflow = textOverflow(el)
    return Math.max(overflow.below, overflow.beside) <= 2 * scale
  }
  try {
    if (!fits(high)) return
    while (low < high) {
      const mid = Math.floor((low + high) / 2)
      if (fits(mid)) high = mid
      else low = mid + 1
    }
    planned.set(el, new DOMRect(r.x, r.y, r.width + (low - box.widthPx) * scale, r.height))
    return { ...box, widthPx: low }
  } finally {
    el.style.width = width
  }
}

function smallerText(box: TextboxDisplay, el: HTMLElement): TextboxDisplay | undefined {
  let changed = false
  const paras = box.paras.map((p, i) => {
    const para = el.querySelectorAll('.doc-textbox-para, .doc-textbox-editor p')[i]
    const inherited = parseFloat(getComputedStyle(para ?? el).fontSize) * 1.5
    return {
      ...p,
      runs: p.runs.map((r) => {
        const size = r.sizeHalfPoints ?? inherited
        if (!r.text.trim() || !Number.isFinite(size) || size <= 12) return r
        changed = true
        return { ...r, sizeHalfPoints: Math.max(12, Math.floor(size * 0.85)) }
      }),
    }
  })
  if (changed) return { ...box, paras }
}

export function fitPendingTranslationBoxes(editor: Editor): boolean {
  if (!pending.has(editor.view.dom)) return false
  // Each pass reads actual glyph rectangles after the previous transaction's
  // synchronous render. Batch the writes so the next read incurs one layout.
  let positions: Set<number> | undefined
  for (let pass = 0; pass < 12; pass++) {
    const tr = editor.state.tr
    const planned = new Map<Element, DOMRect>()
    const hits = clippedBoxes(editor, positions)
    positions = new Set<number>()
    for (const hit of hits) {
      if (hit.box.readOnly || hit.box.rotDeg) continue
      const node = tr.doc.nodeAt(hit.pos)!
      const boxes = (node.attrs[hit.attr] as TextboxDisplay[]).slice()
      const fit = growIntoBand(hit, planned) ?? smallerText(hit.box, hit.el)
      if (!fit) continue
      positions.add(hit.pos)
      boxes[hit.index] = fit
      tr.setNodeMarkup(hit.pos, undefined, { ...node.attrs, [hit.attr]: boxes })
    }
    if (!tr.docChanged) break
    editor.view.dispatch(tr.setMeta('addToHistory', false))
  }
  pending.delete(editor.view.dom)
  return true
}
