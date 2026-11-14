import { useEffect, useRef } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import type { OcrBox } from '../../../shared/ocr-boxes'
import { useI18n } from '../locale'
import { moveBox, newBox, resizeBox } from './ocr-box-geometry'
import { makeText } from './shared'

/** arrow keys move a box by this ratio of the picture; with Shift they resize it; Alt makes it five times larger */
const KEY_STEP = 0.01
const KEY_STEP_LARGE = 0.05

/** geometry numbers rounded, so repeated nudges never leave float noise in a box */
const tidy = (box: OcrBox): OcrBox => ({
  ...box,
  x: Math.round(box.x * 1e4) / 1e4,
  y: Math.round(box.y * 1e4) / 1e4,
  w: Math.round(box.w * 1e4) / 1e4,
  h: Math.round(box.h * 1e4) / 1e4,
})
const percent = (value: number): string => `${Math.round(value * 1e4) / 100}%`

interface Drag {
  index: number
  kind: 'move' | 'resize'
  startX: number
  startY: number
  origin: OcrBox
}

/**
 * One picture with its boxes drawn over it, where the OCR found text. A box moves by dragging
 * it, resizes by dragging its corner handle, and is also reachable by keyboard (arrows move,
 * Shift+arrows resize, Delete removes). The text of the selected box is edited below. Pure view:
 * the boxes live with the caller.
 */
export function OcrBoxEditor({
  src,
  boxes,
  selected,
  disabled,
  onChange,
  onSelect,
}: {
  src: string
  boxes: OcrBox[]
  selected: number | null
  disabled: boolean
  onChange: (boxes: OcrBox[]) => void
  onSelect: (index: number | null) => void
}) {
  const { lang } = useI18n()
  const s = makeText(lang)
  const stage = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const latest = useRef({ boxes, onChange })
  latest.current = { boxes, onChange }

  const replace = (index: number, box: OcrBox) =>
    onChange(boxes.map((b, i) => (i === index ? tidy(box) : b)))
  const remove = (index: number) => {
    onChange(boxes.filter((_, i) => i !== index))
    onSelect(null)
  }

  useEffect(() => {
    const move = (event: globalThis.PointerEvent) => {
      const active = drag.current
      const rect = stage.current?.getBoundingClientRect()
      if (!active || !rect || rect.width === 0 || rect.height === 0) return
      const dx = (event.clientX - active.startX) / rect.width
      const dy = (event.clientY - active.startY) / rect.height
      const box =
        active.kind === 'move' ? moveBox(active.origin, dx, dy) : resizeBox(active.origin, dx, dy)
      const { boxes: current, onChange: change } = latest.current
      change(current.map((b, i) => (i === active.index ? tidy(box) : b)))
    }
    const end = () => {
      drag.current = null
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
  }, [])

  const begin = (event: PointerEvent, index: number, kind: Drag['kind']) => {
    onSelect(index)
    if (disabled) return
    event.stopPropagation()
    drag.current = {
      index,
      kind,
      startX: event.clientX,
      startY: event.clientY,
      origin: boxes[index]!,
    }
  }

  const keyDown = (event: KeyboardEvent, index: number) => {
    if (disabled) return
    const box = boxes[index]!
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      remove(index)
      return
    }
    const step = event.altKey ? KEY_STEP_LARGE : KEY_STEP
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }
    const d = delta[event.key]
    if (!d) return
    event.preventDefault()
    replace(index, event.shiftKey ? resizeBox(box, d[0], d[1]) : moveBox(box, d[0], d[1]))
  }

  const current = selected !== null ? boxes[selected] : undefined
  return (
    <div className="translate-ocr-box-editor">
      <div className="translate-ocr-box-stage" ref={stage}>
        <img src={src} alt="" draggable={false} />
        {boxes.map((box, i) => (
          <div
            key={i}
            data-box
            role="button"
            tabIndex={0}
            aria-pressed={selected === i}
            aria-label={s('ocrBoxLabel', { n: i + 1, text: box.text })}
            className={`translate-ocr-box${selected === i ? ' is-selected' : ''}`}
            style={{
              left: percent(box.x),
              top: percent(box.y),
              width: percent(box.w),
              height: percent(box.h),
            }}
            onClick={() => onSelect(i)}
            onPointerDown={(event) => begin(event, i, 'move')}
            onKeyDown={(event) => keyDown(event, i)}
          >
            <span
              className="translate-ocr-box-handle"
              aria-hidden="true"
              onPointerDown={(event) => begin(event, i, 'resize')}
            />
          </div>
        ))}
      </div>
      <div className="translate-ocr-box-tools">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={disabled}
          onClick={() => {
            onChange([...boxes, newBox()])
            onSelect(boxes.length)
          }}
        >
          {s('ocrBoxAdd')}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={disabled || selected === null || !current}
          onClick={() => selected !== null && remove(selected)}
        >
          {s('ocrBoxDelete')}
        </button>
      </div>
      {current && selected !== null && (
        <label className="projects-field">
          <span>{s('ocrBoxText')}</span>
          <textarea
            aria-label={s('ocrBoxText')}
            rows={3}
            value={current.text}
            disabled={disabled}
            onChange={(event) => replace(selected, { ...current, text: event.target.value })}
          />
        </label>
      )}
    </div>
  )
}
