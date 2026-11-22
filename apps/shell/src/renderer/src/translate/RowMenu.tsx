import { useEffect, useRef, useState } from 'react'
import { MoreIcon, SortChevron } from './icons'

export interface RowMenuItem {
  key: string
  label: string
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
}

/**
 * The "..." button of a table row and its menu. Closes on Escape (focus returns to the
 * button), on a click outside and after a choice; Up/Down move between the items.
 */
export function RowMenu({
  label,
  items,
  disabled,
  split = false,
}: {
  /** accessible name of the button, e.g. "More actions: Contracts" */
  label: string
  items: RowMenuItem[]
  split?: boolean
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLSpanElement>(null)
  const button = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  useEffect(() => {
    if (open)
      wrap.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
  }, [open])

  const close = (refocus: boolean) => {
    setOpen(false)
    if (refocus) button.current?.focus()
  }

  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      close(true)
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const all = [
      ...(wrap.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ??
        []),
    ]
    const at = all.indexOf(document.activeElement as HTMLButtonElement)
    const next = e.key === 'ArrowDown' ? at + 1 : at - 1
    all[(next + all.length) % all.length]?.focus()
  }

  return (
    <span
      className={`tt-menu-wrap${open ? ' is-open' : ''}`}
      ref={wrap}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <button
        ref={button}
        type="button"
        className={split ? 'projects-ghost translate-split-toggle' : 'tt-icon-btn'}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        {split ? <SortChevron dir="desc" /> : <MoreIcon />}
      </button>
      {open && (
        <div className="tt-menu" role="menu" onKeyDown={onMenuKey}>
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className={item.danger ? 'is-danger' : undefined}
              disabled={item.disabled}
              onClick={() => {
                close(split)
                item.onSelect()
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}
