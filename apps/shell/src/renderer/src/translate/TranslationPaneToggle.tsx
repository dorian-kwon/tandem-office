import { useEffect, useRef, useState } from 'react'
import type { SplitViewState } from '../../../shared/split-view-api'
import type { TabSummary } from '../../../shared/tabs-api'
import { useI18n } from '../locale'
import { saveAsNoticeFor, type SaveAsNotice } from './save-as-action'
import { makeText } from './shared'
import { dismissSourceChanged, useChangedSources } from './source-change-notice'
import './translate.css'
import './translate-global'

const basenameOf = (path: string): string => path.split(/[\\/]/).pop() ?? path

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
  const [exportNotice, setExportNotice] = useState<SaveAsNotice | null>(null)
  const [exporting, setExporting] = useState(false)
  // the result of an export stays on the strip for a few seconds
  useEffect(() => {
    if (!exportNotice) return undefined
    const timer = setTimeout(() => setExportNotice(null), 6000)
    return () => clearTimeout(timer)
  }, [exportNotice])
  const api = window.translateApi
  const savingRef = useRef(false)
  const runSaveAs = (outputPath: string) => {
    if (!api || savingRef.current) return
    savingRef.current = true
    setExporting(true)
    void saveAsNoticeFor(lang, api, { outputPath })
      .then(setExportNotice)
      .finally(() => {
        savingRef.current = false
        setExporting(false)
      })
  }
  const runSaveAsRef = useRef(runSaveAs)
  runSaveAsRef.current = runSaveAs
  // the tab menu's Save As on the output tab lands here, so it copies instead of retargeting the pane
  useEffect(
    () => api?.onSaveAsRequested?.(({ outputPath }) => runSaveAsRef.current(outputPath)),
    [api],
  )
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
  const outputTabId = sourceTabId === split.aTabId ? split.bTabId : split.aTabId
  const outputPath = tabs.find((t) => t.id === outputTabId)?.filePath
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
        {outputPath && (
          <button
            type="button"
            className="translate-pane-toggle-btn"
            data-action="save-as-translation"
            disabled={exporting}
            title={outputPath ? `${s('saveAsTranslation')} ${basenameOf(outputPath)}` : s('saveAsTranslation')}
            onClick={() => outputPath && runSaveAs(outputPath)}
          >
            {s('saveAsTranslation')}
          </button>
        )}
      </div>
      {exportNotice && (
        <div
          className={`translate-source-notice${exportNotice.isError ? ' is-error' : ''}`}
          role={exportNotice.isError ? 'alert' : 'status'}
          title={exportNotice.text}
        >
          <span>{exportNotice.text}</span>
          <button
            type="button"
            className="translate-source-notice-close"
            aria-label={s('dismissNotice')}
            title={s('dismissNotice')}
            onClick={() => setExportNotice(null)}
          >
            ×
          </button>
        </div>
      )}
    </>
  )
}
