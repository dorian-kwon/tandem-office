import type { SplitViewState } from '../../../shared/split-view-api'
import type { TabSummary } from '../../../shared/tabs-api'
import { useI18n } from '../locale'
import { makeText } from './shared'
import { dismissSourceChanged, useChangedSources } from './source-change-notice'
import './translate.css'
import './translate-global'

export interface TranslationPaneToggleProps {
  split: SplitViewState | null
  tabs: TabSummary[]
}

/**
 * The translation view's hide/show control, in the tab strip: the panes are
 * editor views painted over every shell element, so the strip is the one
 * chrome that stays visible. Shown only while the split holds a read-only
 * (source) pane. Hiding keeps the pane's document alive; only one pane can be
 * hidden, so hiding one shows the other (main: TabManager.setPaneHidden).
 * When the source copy had changed since it was added, a dismissible notice
 * sits next to the buttons.
 */
export function TranslationPaneToggle({ split, tabs }: TranslationPaneToggleProps) {
  const { lang } = useI18n()
  const s = makeText(lang)
  const changedSources = useChangedSources()
  const api = window.translateApi
  if (!split || !api) return null
  const readOnlyOf = (id: string) => tabs.find((t) => t.id === id)?.readOnly === true
  if (!readOnlyOf(split.aTabId) && !readOnlyOf(split.bTabId)) return null

  const button = (pane: 'a' | 'b') => {
    const hidden = split.collapsed === pane
    const isSource = readOnlyOf(pane === 'a' ? split.aTabId : split.bTabId)
    const label = isSource
      ? s(hidden ? 'showSource' : 'hideSource')
      : s(hidden ? 'showOutput' : 'hideOutput')
    return (
      <button
        type="button"
        className={`translate-pane-toggle-btn${hidden ? ' is-hidden' : ''}`}
        aria-pressed={hidden}
        title={label}
        onClick={() => {
          // a refused toggle (the split changed meanwhile) changes nothing
          void api
            .setPaneHidden({ side: pane === 'a' ? 'left' : 'right', hidden: !hidden })
            .catch(() => undefined)
        }}
      >
        {label}
      </button>
    )
  }

  const sourceTabId = readOnlyOf(split.aTabId) ? split.aTabId : split.bTabId
  return (
    <>
      {changedSources.has(sourceTabId) && (
        <div className="translate-source-notice" role="status" title={s('warnSourceChanged')}>
          <span>{s('sourceChangedShort')}</span>
          <button
            type="button"
            className="translate-source-notice-close"
            aria-label={s('dismissNotice')}
            title={s('dismissNotice')}
            onClick={() => dismissSourceChanged(sourceTabId)}
          >
            ×
          </button>
        </div>
      )}
      <div className="translate-pane-toggle" role="group" aria-label={s('paneToggleGroup')}>
        {button('a')}
        {button('b')}
      </div>
    </>
  )
}
