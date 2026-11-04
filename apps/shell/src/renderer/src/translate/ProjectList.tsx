import { useCallback, useEffect, useState } from 'react'
import { LANGS } from '@genoffice/i18n'
import type {
  TranslateAdoptedProject,
  TranslatePickedParentDir,
  TranslateProjectListEntry,
  TranslateRecentDocument,
} from '../../../shared/translate-api'
import { useI18n } from '../locale'
import { languageName, makeText, translateErrorText } from './shared'
import '../projects-panel.css'
import './translate.css'
import './translate-global'

export interface ProjectListProps {
  /** open a project's detail screen */
  onOpen: (dir: string) => void
  /** reopen a recent document: its project and source file name */
  onOpenRecent?: (dir: string, file: string) => Promise<void>
}

/** "3 minutes ago" in the screen language */
function relativeTime(lang: string, at: number, now: number): string {
  const seconds = Math.round((at - now) / 1000)
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ]
  try {
    const fmt = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' })
    for (const [unit, size] of units)
      if (Math.abs(seconds) >= size) return fmt.format(Math.round(seconds / size), unit)
    return fmt.format(0, 'second')
  } catch {
    return new Date(at).toLocaleString()
  }
}

type Deleting = { entry: TranslateProjectListEntry; step: 'choose' | 'confirm-folder' }

/** The translation tool's home: global system prompt, create dialog and the project list. */
export function ProjectList({ onOpen, onOpenRecent }: ProjectListProps) {
  const { lang } = useI18n()
  const s = makeText(lang)
  const api = window.translateApi
  const [projects, setProjects] = useState<TranslateProjectListEntry[] | null>(null)
  const [recent, setRecent] = useState<TranslateRecentDocument[]>([])
  const [systemPrompt, setSystemPrompt] = useState('')
  const [promptLoaded, setPromptLoaded] = useState(false)
  const [promptSaved, setPromptSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [sourceLang, setSourceLang] = useState('ko')
  const [targetLang, setTargetLang] = useState('en')
  const [parent, setParent] = useState<TranslatePickedParentDir | null>(null)
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState<Deleting | null>(null)
  /** an added folder whose AI context is not linked (foreign instructions or memory) */
  const [notLinked, setNotLinked] = useState(false)

  const fail = useCallback((err: unknown) => setError(translateErrorText(lang, err)), [lang])

  const reload = useCallback(async () => {
    if (!api) return
    try {
      setProjects(await api.list())
    } catch (err) {
      fail(err)
    }
  }, [api, fail])

  useEffect(() => {
    if (!api) return
    void reload()
    api.recent().then(setRecent, () => setRecent([]))
    api.getSystemPrompt().then(
      (text) => {
        setSystemPrompt(text)
        setPromptLoaded(true)
      },
      (err: unknown) => fail(err),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per mount
  }, [])

  if (!api) return <main className="content projects-panel" />

  const saveSystemPrompt = () => {
    // never write the empty initial value over a stored prompt that failed to load
    if (!promptLoaded) return
    api
      .setSystemPrompt(systemPrompt)
      .then(() => setPromptSaved(true))
      .catch(fail)
  }

  const startCreate = () => {
    setCreating(true)
    setError(null)
  }

  const choosePlace = async () => {
    try {
      const picked = await api.pickParentDir()
      if (picked) setParent(picked)
    } catch (err) {
      fail(err)
    }
  }

  const submitCreate = async () => {
    if (!parent || !name.trim()) return
    setBusy(true)
    setError(null)
    try {
      const { dir } = await api.create({
        parentToken: parent.token,
        name: name.trim(),
        sourceLang,
        targetLang,
      })
      setCreating(false)
      setName('')
      setParent(null)
      await reload()
      onOpen(dir)
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  /**
   * A project folder made elsewhere (moved, copied) or a listed one whose folder
   * moved: main opens the folder dialog and checks the project file. A folder the
   * AI panels cannot use yet stays in the list with a note instead of opening.
   */
  const adopt = async (pick: () => Promise<TranslateAdoptedProject | null>) => {
    setBusy(true)
    setError(null)
    setNotLinked(false)
    try {
      const adopted = await pick()
      if (!adopted) return
      await reload()
      if (adopted.contextLinked) onOpen(adopted.dir)
      else setNotLinked(true)
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (dir: string, deleteFolder: boolean) => {
    setBusy(true)
    setError(null)
    try {
      await api.remove({ dir, deleteFolder })
    } catch (err) {
      fail(err)
    } finally {
      setDeleting(null)
      setBusy(false)
      await reload()
    }
  }

  const renderRow = (entry: TranslateProjectListEntry) => {
    const usable = entry.status === 'ok'
    return (
      <li
        key={entry.dir}
        className={`projects-row translate-card${usable ? '' : ' is-broken'}`}
        data-project-dir={entry.dir}
      >
        {usable ? (
          <button type="button" className="translate-open" onClick={() => onOpen(entry.dir)}>
            <span className="projects-row-name">{entry.name}</span>
            <span className="translate-chip">
              {languageName(lang, entry.sourceLang)} {'→'} {languageName(lang, entry.targetLang)}
            </span>
            <span className="translate-meta">
              <span>{s('countSources', { n: entry.sourceCount })}</span>
              <span>{s('countReferences', { n: entry.referenceCount })}</span>
              {entry.lastOpened > 0 && (
                <span>{relativeTime(lang, entry.lastOpened, Date.now())}</span>
              )}
            </span>
          </button>
        ) : (
          <div className="translate-row-main is-disabled" aria-disabled="true">
            <span className="projects-row-name">{entry.name}</span>
            <span className="projects-row-path">{entry.dir}</span>
            <span className="projects-mark is-warning">
              {entry.status === 'not-found' ? s('statusNotFound') : s('statusInvalid')}
            </span>
          </div>
        )}
        <div className="translate-row-actions">
          {usable ? (
            <button
              type="button"
              className="projects-small translate-quiet"
              disabled={busy}
              onClick={() => setDeleting({ entry, step: 'choose' })}
            >
              {s('deleteProject')}
            </button>
          ) : (
            <>
              {entry.status === 'not-found' && (
                <button
                  type="button"
                  className="projects-small"
                  disabled={busy}
                  onClick={() => void adopt(() => api.relocate({ dir: entry.dir }))}
                >
                  {s('locateFolder')}
                </button>
              )}
              <button
                type="button"
                className="projects-small"
                disabled={busy}
                onClick={() => void remove(entry.dir, false)}
              >
                {s('removeFromList')}
              </button>
            </>
          )}
        </div>
      </li>
    )
  }

  const languageSelect = (value: string, label: string, set: (code: string) => void) => (
    <label className="projects-field">
      <span className="projects-field-label">{label}</span>
      <select className="translate-select" value={value} onChange={(e) => set(e.target.value)}>
        {LANGS.map((code) => (
          <option key={code} value={code}>
            {languageName(lang, code)}
          </option>
        ))}
      </select>
    </label>
  )

  return (
    <main className="content projects-panel">
      <div className="translate-pane">
        <header className="translate-head">
          <div className="translate-head-text">
            <h2 className="translate-title">{s('title')}</h2>
            <p className="translate-lede">{s('intro')}</p>
          </div>
          <div className="translate-head-actions">
            {/* an empty list carries the primary action in its own card instead */}
            {(creating || projects === null || projects.length > 0) && (
              <button type="button" className="projects-primary" onClick={startCreate}>
                {s('newProject')}
              </button>
            )}
            <button
              type="button"
              className="projects-ghost"
              disabled={busy}
              onClick={() => void adopt(() => api.pickExisting())}
            >
              {s('openExisting')}
            </button>
          </div>
        </header>

        {error && (
          <div className="projects-note is-warning translate-error" role="alert">
            {error}
          </div>
        )}
        {notLinked && (
          <div className="projects-note is-warning" role="status" data-not-linked>
            {s('adoptNotLinked')}
          </div>
        )}

        {creating && (
          <form
            className="projects-create"
            onSubmit={(e) => {
              e.preventDefault()
              void submitCreate()
            }}
          >
            <label className="projects-field">
              <span className="projects-field-label">{s('nameLabel')}</span>
              <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </label>
            <div className="translate-lang-row">
              {languageSelect(sourceLang, s('sourceLangLabel'), setSourceLang)}
              {languageSelect(targetLang, s('targetLangLabel'), setTargetLang)}
            </div>
            <div className="projects-field">
              <span className="projects-field-label">{s('parentLabel')}</span>
              <p className="projects-location">{parent ? parent.dir : s('noFolderChosen')}</p>
              <div>
                <button type="button" className="projects-ghost" onClick={() => void choosePlace()}>
                  {s('chooseFolder')}
                </button>
              </div>
            </div>
            <div className="projects-buttons">
              <button
                type="submit"
                className="projects-primary"
                disabled={busy || !parent || !name.trim()}
              >
                {s('create')}
              </button>
              <button type="button" className="projects-ghost" onClick={() => setCreating(false)}>
                {s('cancel')}
              </button>
            </div>
          </form>
        )}

        {deleting && (
          <div
            className="translate-confirm"
            role="alertdialog"
            aria-label={s('deleteTitle', { name: deleting.entry.name })}
          >
            <p className="translate-confirm-title">
              {s('deleteTitle', { name: deleting.entry.name })}
            </p>
            {deleting.step === 'choose' ? (
              <div className="projects-buttons">
                <button
                  type="button"
                  className="projects-ghost"
                  disabled={busy}
                  onClick={() => void remove(deleting.entry.dir, false)}
                >
                  {s('deleteListOnly')}
                </button>
                <button
                  type="button"
                  className="projects-ghost"
                  disabled={busy}
                  onClick={() => setDeleting({ entry: deleting.entry, step: 'confirm-folder' })}
                >
                  {s('deleteListAndFolder')}
                </button>
                <button type="button" className="projects-ghost" onClick={() => setDeleting(null)}>
                  {s('cancel')}
                </button>
              </div>
            ) : (
              <>
                <p className="projects-location">
                  {s('deleteFolderConfirm', { dir: deleting.entry.dir })}
                </p>
                <div className="projects-buttons">
                  <button
                    type="button"
                    className="projects-primary"
                    disabled={busy}
                    onClick={() => void remove(deleting.entry.dir, true)}
                  >
                    {s('deleteFolderConfirmButton')}
                  </button>
                  <button
                    type="button"
                    className="projects-ghost"
                    onClick={() => setDeleting(null)}
                  >
                    {s('cancel')}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {projects !== null && projects.length === 0 && !creating && (
          <div className="translate-empty" data-empty-projects>
            <p className="translate-empty-text">{s('emptyHint')}</p>
            <button type="button" className="projects-primary" onClick={startCreate}>
              {s('newProject')}
            </button>
          </div>
        )}
        {projects !== null && projects.length > 0 && (
          <ul className="translate-cards">{projects.map(renderRow)}</ul>
        )}

        {recent.length > 0 && (
          <section className="translate-recent" data-recent-list>
            <h3 className="translate-section-title">{s('recentTitle')}</h3>
            <ul className="translate-rows">
              {recent.map((doc) => (
                <li
                  key={`${doc.dir}\n${doc.file}`}
                  className="projects-row"
                  data-recent-file={doc.file}
                >
                  {doc.available ? (
                    <button
                      type="button"
                      className="translate-open"
                      onClick={() => {
                        setError(null)
                        void onOpenRecent?.(doc.dir, doc.file).catch(fail)
                      }}
                    >
                      <span className="projects-row-name">{doc.file}</span>
                      <span className="translate-meta">
                        <span>{doc.projectName}</span>
                        <span>
                          {languageName(lang, doc.sourceLang)} {'→'}{' '}
                          {languageName(lang, doc.targetLang)}
                        </span>
                        <span>{relativeTime(lang, doc.openedAt, Date.now())}</span>
                      </span>
                    </button>
                  ) : (
                    <div className="translate-row-main is-disabled" aria-disabled="true">
                      <span className="projects-row-name">{doc.file}</span>
                      <span className="projects-row-path">{doc.projectName}</span>
                      <span className="projects-mark is-warning">{s('recentUnavailable')}</span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        <label className="projects-field translate-card-section">
          <span className="translate-field-head">
            <span className="projects-field-label">{s('systemPromptLabel')}</span>
            {promptSaved && (
              <span className="translate-saved" role="status">
                {s('saved')}
              </span>
            )}
          </span>
          <textarea
            className="projects-textarea"
            aria-label={s('systemPromptLabel')}
            value={systemPrompt}
            onChange={(e) => {
              setSystemPrompt(e.target.value)
              setPromptSaved(false)
            }}
            onBlur={saveSystemPrompt}
          />
          <span className="projects-hint">{s('systemPromptHint')}</span>
        </label>
      </div>
    </main>
  )
}
