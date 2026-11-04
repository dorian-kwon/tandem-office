import { useEffect, useRef } from 'react'
import { PROJECT_NAME_MAX } from '../../../shared/project-name'

/**
 * An in-place name field. Enter or leaving the field saves, Escape cancels. `onSave` gets the
 * raw text; the caller validates, stores and closes the field (or keeps it open to show an error).
 */
export function InlineName({
  initial,
  label,
  placeholder,
  onSave,
  onCancel,
}: {
  initial: string
  label: string
  placeholder: string
  onSave: (raw: string) => void
  onCancel: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  // set by Escape and by Enter so the blur that follows does not save a second time
  const done = useRef(false)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  return (
    <input
      ref={input}
      className="tt-name-input"
      defaultValue={initial}
      aria-label={label}
      placeholder={placeholder}
      maxLength={PROJECT_NAME_MAX * 2}
      data-rename-input
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          done.current = true
          onSave(e.currentTarget.value)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          done.current = true
          onCancel()
        }
      }}
      onBlur={(e) => {
        if (done.current) return
        done.current = true
        onSave(e.currentTarget.value)
      }}
    />
  )
}
