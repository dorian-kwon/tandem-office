import { useLayoutEffect, useRef, useState } from 'react'
import type { Lang } from '@genoffice/i18n'
import { CHAT_WINDOW_STRINGS } from './strings-chat-window'
import './chat-window.css'

export interface ChatWindowEntry {
  readonly role: string
  readonly text?: string | undefined
  readonly streaming?: boolean | undefined
}

/** Keep whole turns, including any still streaming, without changing stored/model history. */
export function recentChatStart(entries: readonly ChatWindowEntry[], limit = 30): number {
  let start = Math.max(0, entries.length - Math.max(1, limit))
  const streaming = entries.findIndex((entry) => entry.streaming)
  if (streaming >= 0) start = Math.min(start, streaming)
  while (start > 0 && entries[start]?.role !== 'user') start--
  return start
}

const EMPTY: readonly ChatWindowEntry[] = []

/** Indices remain those of the complete arrays (undo, citations and retries use them). */
export function useChatWindow<C extends ChatWindowEntry, H extends ChatWindowEntry = C>(
  chat: readonly C[],
  busy: boolean,
  history: readonly H[] = EMPTY as readonly H[],
) {
  const [expanded, setExpanded] = useState(false)
  const users = chat.reduce((count, entry) => count + Number(entry.role === 'user'), 0)
  const [previous, setPrevious] = useState({ busy, users })
  const reset = (busy && !previous.busy) || users !== previous.users
  if (previous.busy !== busy || reset) {
    setPrevious({ busy, users })
    if (reset && expanded) setExpanded(false)
  }
  const start = expanded && !reset ? 0 : recentChatStart([...history, ...chat])
  return {
    hidden: start,
    expand: () => setExpanded(true),
    history: history.slice(start).map((entry, i) => ({ entry, index: i + start })),
    chat: chat.slice(Math.max(0, start - history.length)).map((entry, i) => ({
      entry,
      index: i + Math.max(0, start - history.length),
    })),
  }
}

/** Keep the current messages at their scroll position when older turns are inserted above. */
export function EarlierChatMessages({
  hidden,
  expand,
  lang,
}: {
  hidden: number
  expand: () => void
  lang: Lang
}): React.JSX.Element | null {
  const button = useRef<HTMLButtonElement>(null)
  const scroll = useRef<{ element: HTMLElement; height: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const before = scroll.current
    if (before && hidden === 0) {
      before.element.scrollTop = before.top + before.element.scrollHeight - before.height
      scroll.current = null
    }
  }, [hidden])
  if (!hidden) return null
  return (
    <button
      ref={button}
      type="button"
      className="ai-history-more"
      onClick={() => {
        const element = button.current?.parentElement
        if (element)
          scroll.current = { element, height: element.scrollHeight, top: element.scrollTop }
        expand()
      }}
    >
      {CHAT_WINDOW_STRINGS[lang].replace('{count}', String(hidden))}
    </button>
  )
}
