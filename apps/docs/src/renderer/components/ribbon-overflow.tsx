import { Children, Fragment, isValidElement, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useDismissablePopover } from '@genoffice/ui'
import { useI18n } from '../i18n/locale'

/** Keep the selected tab visible, then fill remaining room in reading order. */
export function fittingRibbonItems(
  widths: number[],
  available: number,
  trigger: number,
  active = -1,
): number[] {
  if (widths.reduce((sum, width) => sum + width, 0) <= available) return widths.map((_, i) => i)
  let room = Math.max(0, available - trigger)
  const visible: number[] = []
  const order =
    active >= 0
      ? [active, ...widths.map((_, i) => i).filter((i) => i !== active)]
      : widths.map((_, i) => i)
  for (const index of order) {
    if (widths[index]! > room) continue
    visible.push(index)
    room -= widths[index]!
  }
  return visible.sort((a, b) => a - b)
}

function flatten(children: ReactNode): ReactNode[] {
  return Children.toArray(children).flatMap((child) =>
    isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment
      ? flatten(child.props.children)
      : [child],
  )
}

/** A live, measurable overflow: commands are never cloned or replaced with shortcuts. */
export function RibbonOverflow({
  children,
  label,
  tabs = false,
}: {
  children: ReactNode
  label?: string
  tabs?: boolean
}) {
  const { t } = useI18n()
  const caption = label ?? t('ribbonMore')
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const items = useRef(new Map<number, HTMLDivElement>())
  const [visible, setVisible] = useState<number[] | null>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 8, top: 0, maxHeight: 420 })
  const id = useId()
  // Dialogs and other auxiliary children stay outside the measured command strip.
  const all = flatten(children)
  const commands = all.filter(
    (child) =>
      isValidElement<{ className?: string }>(child) &&
      (tabs || /(?:ribbon-group|table-tool-group)/.test(child.props.className ?? '')),
  )
  const auxiliary = tabs
    ? []
    : all.filter(
        (child) =>
          !commands.includes(child) &&
          !(
            isValidElement<{ className?: string }>(child) && child.props.className === 'ribbon-sep'
          ),
      )
  const active = tabs
    ? commands.findIndex(
        (child) =>
          isValidElement<{ className?: string }>(child) &&
          /\bactive\b/.test(child.props.className ?? ''),
      )
    : -1

  useLayoutEffect(() => {
    const measure = () => {
      if (!root.current || !trigger.current) return
      const available = root.current.getBoundingClientRect().width
      if (!available) return // jsdom and temporarily hidden editor panes have no layout.
      const gap = tabs ? 2 : 0
      const widths = commands.map(
        (_, i) => (items.current.get(i)?.getBoundingClientRect().width ?? 0) + gap,
      )
      const next = fittingRibbonItems(
        widths,
        available + gap,
        trigger.current.getBoundingClientRect().width + 4,
        active,
      )
      setVisible((previous) => (previous?.join() === next.join() ? previous : next))
      const anchor = trigger.current.getBoundingClientRect()
      setPosition((previous) => {
        const left = Math.max(
          8,
          Math.min(
            anchor.left,
            window.innerWidth - (panel.current?.getBoundingClientRect().width ?? 360) - 8,
          ),
        )
        const top = anchor.bottom + 4
        const maxHeight = Math.max(80, window.innerHeight - top - 8)
        return previous.left === left && previous.top === top && previous.maxHeight === maxHeight
          ? previous
          : { left, top, maxHeight }
      })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    if (root.current) observer.observe(root.current)
    for (const item of items.current.values()) observer.observe(item)
    return () => observer.disconnect()
  })

  const shown = commands.map((_, i) => i).filter((i) => visible === null || visible.includes(i))
  const hidden = commands.map((_, i) => i).filter((i) => !shown.includes(i))
  const close = () => setOpen(false)
  useDismissablePopover(open, close, { inside: () => [trigger.current, panel.current] })
  useLayoutEffect(() => {
    if (open)
      panel.current
        ?.querySelector<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
        )
        ?.focus({ preventScroll: true })
  }, [open])
  useLayoutEffect(() => {
    if (!hidden.length) setOpen(false)
  }, [hidden.length])
  const item = (index: number) => (
    <div
      className="ribbon-overflow-item"
      key={isValidElement(commands[index]) ? (commands[index].key ?? index) : index}
      ref={(element) => {
        if (element) items.current.set(index, element)
        else items.current.delete(index)
      }}
    >
      {commands[index]}
      {!tabs &&
        (() => {
          const next = all[all.indexOf(commands[index]) + 1]
          return isValidElement<{ className?: string }>(next) &&
            next.props.className === 'ribbon-sep'
            ? next
            : null
        })()}
    </div>
  )
  const ribbonClass = root.current?.closest('.ribbon')?.className ?? 'ribbon'

  return (
    <>
      <div ref={root} className={`ribbon-overflow${tabs ? ' ribbon-overflow-tabs' : ''}`}>
        {shown.map(item)}
        <button
          ref={trigger}
          className={`ribbon-overflow-trigger${tabs ? ' ribbon-tab' : ' rb-big'}`}
          style={
            hidden.length
              ? undefined
              : { position: 'absolute', visibility: 'hidden', pointerEvents: 'none' }
          }
          tabIndex={hidden.length ? 0 : -1}
          aria-hidden={!hidden.length}
          aria-expanded={open}
          aria-controls={id}
          aria-haspopup="dialog"
          onClick={() => setOpen((value) => !value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setOpen(true)
            }
          }}
        >
          {caption} <span aria-hidden="true">⌄</span>
        </button>
      </div>
      {createPortal(
        <div
          id={id}
          ref={panel}
          className={`${ribbonClass} ribbon-overflow-panel${tabs ? ' ribbon-overflow-tab-panel' : ''}`}
          role="dialog"
          aria-label={caption}
          aria-hidden={!open}
          inert={!open}
          style={{
            left: position.left,
            top: position.top,
            maxHeight: position.maxHeight,
            visibility: open ? 'visible' : 'hidden',
          }}
          onMouseDown={(event) => {
            if (!(
              event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement
            ))
              event.preventDefault()
          }}
          onClick={tabs ? close : undefined}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !event.defaultPrevented) {
              event.preventDefault()
              event.stopPropagation()
              close()
              trigger.current?.focus({ preventScroll: true })
            }
          }}
        >
          {hidden.map(item)}
        </div>,
        document.body,
      )}
      {auxiliary}
    </>
  )
}
