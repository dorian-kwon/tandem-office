import { useRef, useState } from 'react'
import type { WikiFinalResult } from '../../../shared/translate-api'
import { useI18n } from '../locale'
import type { TranslateStringKey } from '../i18n/strings-translate'
import { makeText, translateErrorText } from './shared'
import { RowMenu } from './RowMenu'
import './translate-global'

const statusLabels: Record<WikiFinalResult['status'], TranslateStringKey> = {
  added: 'wikiLearnAdded',
  updated: 'wikiLearnUpdated',
  duplicate: 'wikiLearnDuplicate',
  empty: 'wikiLearnEmpty',
  failed: 'wikiLearnFailed',
}

/** At home the native picker chooses files. A project already knows its saved outputs. */
export function useWikiFinalLearning(projectDir?: string) {
  const { lang } = useI18n()
  const s = makeText(lang)
  const [results, setResults] = useState<WikiFinalResult[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [learning, setLearning] = useState(false)
  const [maintenance, setMaintenance] = useState<'initialize' | 'repair' | null>(null)
  const [notice, setNotice] = useState<TranslateStringKey | null>(null)
  const pending = useRef(false)
  const busy = learning || maintenance !== null

  async function learn() {
    const api = window.translateApi
    if (!api || pending.current) return
    pending.current = true
    setLearning(true)
    setNotice(null)
    setError(null)
    try {
      const next =
        projectDir === undefined
          ? await api.learnFinals()
          : await api.learnProjectFinals(projectDir)
      if (projectDir !== undefined || next.length) setResults(next)
    } catch (err) {
      setError(translateErrorText(lang, err))
    } finally {
      pending.current = false
      setLearning(false)
    }
  }

  async function maintain(action: 'initialize' | 'repair') {
    const api = window.translateApi
    if (!api || pending.current) return
    if (action === 'initialize' && !window.confirm(s('wikiInitializeConfirm'))) return
    pending.current = true
    setMaintenance(action)
    setError(null)
    setNotice(null)
    try {
      await api.maintainWiki(action)
      if (action === 'initialize') setResults(null)
      setNotice(action === 'initialize' ? 'wikiInitialized' : 'wikiRepaired')
    } catch (err) {
      setError(translateErrorText(lang, err))
    } finally {
      pending.current = false
      setMaintenance(null)
    }
  }

  return {
    button: (
      <span className="translate-wiki-split">
        <button
          type="button"
          className="projects-ghost"
          data-testid={projectDir === undefined ? undefined : 'project-learn-finals'}
          disabled={busy}
          aria-busy={learning}
          onClick={() => void learn()}
        >
          {learning
            ? s(projectDir === undefined ? 'wikiLearning' : 'wikiProjectLearning')
            : s('wikiLearn')}
        </button>
        <RowMenu
          label={s('wikiManage')}
          split
          disabled={busy}
          items={[
            {
              key: 'initialize',
              label: s('wikiInitialize'),
              onSelect: () => void maintain('initialize'),
            },
            { key: 'repair', label: s('wikiRepair'), onSelect: () => void maintain('repair') },
          ]}
        />
      </span>
    ),
    report: (
      <>
        <div aria-live="polite">
          {(maintenance || notice) && (
            <div className="projects-note">
              {maintenance ? s('wikiMaintaining') : notice && s(notice)}
            </div>
          )}
          {results !== null && (
            <div className="projects-note translate-learn-results">
              {results.length ? (
                <ul>
                  {results.map(({ name, status }, index) => (
                    <li key={index}>
                      <bdi>{name}</bdi> — {s(statusLabels[status])}
                    </li>
                  ))}
                </ul>
              ) : (
                <span>{s('wikiProjectNoFinals')}</span>
              )}
              <button type="button" className="projects-ghost" onClick={() => setResults(null)}>
                {s('trClose')}
              </button>
            </div>
          )}
        </div>
        {error && (
          <div className="projects-note is-warning translate-error" role="alert">
            {error}
          </div>
        )}
      </>
    ),
  }
}
