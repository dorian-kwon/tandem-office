import { useCallback, useEffect, useState } from 'react'
import { LANGS } from '@genoffice/i18n'
import type {
  TranslateAdoptedProject,
  TranslatePickedParentDir,
  TranslateProjectListEntry,
  TranslateRecentDocument,
} from '../../../shared/translate-api'
import { useI18n } from '../locale'
import { normalizeProjectName } from '../../../shared/project-name'
import { InlineName } from './InlineName'
import { FileIcon, glyphForFile, ProjectIcon, SortChevron } from './icons'
import {
  filterProjects,
  middleEllipsis,
  paginate,
  PROJECT_PAGE_SIZE,
  moveRowFocus,
  readSessionSort,
  sortProjects,
  writeSessionSort,
  type SortKey,
  type SortState,
} from './project-table'
import { RowMenu, type RowMenuItem } from './RowMenu'
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
  /** the project whose name is being edited in its row */
  const [renaming, setRenaming] = useState<string | null>(null)
  const [sort, setSort] = useState<SortState>(readSessionSort)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
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

  const forgetRecent = async (dir: string, file: string) => {
    setRecent((list) => list.filter((d) => !(d.dir === dir && d.file === file)))
    try {
      await api.forgetRecent({ dir, file })
    } catch (err) {
      fail(err)
    }
    api.recent().then(setRecent, () => undefined)
  }

  const chooseSort = (key: SortKey) => {
    // the same column again flips the direction; a new column starts newest/A first
    const next: SortState =
      sort.key === key
        ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'name' ? 'asc' : 'desc' }
    writeSessionSort(next)
    setSort(next)
  }

  const saveRename = async (entry: TranslateProjectListEntry, raw: string) => {
    setRenaming(null)
    const next = normalizeProjectName(raw)
    if (next === null) {
      setError(s('renameInvalid'))
      return
    }
    if (next === entry.name) return
    setBusy(true)
    setError(null)
    try {
      await api.rename({ dir: entry.dir, name: next })
      await reload()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const sortHeader = (key: SortKey, label: string, extra = '') => (
    <div
      role="columnheader"
      className={`tt-col${extra}`}
      aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        className={`tt-sort${sort.key === key ? ' is-active' : ''}`}
        aria-label={s('sortBy', { column: label })}
        onClick={() => chooseSort(key)}
      >
        {label}
        {sort.key === key && <SortChevron dir={sort.dir} />}
      </button>
    </div>
  )

  const renderRow = (entry: TranslateProjectListEntry) => {
    const usable = entry.status === 'ok'
    const items: RowMenuItem[] = usable
      ? [
          { key: 'rename', label: s('rename'), onSelect: () => setRenaming(entry.dir) },
          {
            key: 'delete',
            label: s('deleteProject'),
            danger: true,
            onSelect: () => setDeleting({ entry, step: 'choose' }),
          },
        ]
      : [
          ...(entry.status === 'not-found'
            ? [
                {
                  key: 'locate',
                  label: s('locateFolder'),
                  onSelect: () => void adopt(() => api.relocate({ dir: entry.dir })),
                },
              ]
            : []),
          {
            key: 'remove',
            label: s('removeFromList'),
            onSelect: () => void remove(entry.dir, false),
          },
        ]
    const editing = renaming === entry.dir
    return (
      <div
        key={entry.dir}
        role="row"
        className={`tt-row${usable ? ' is-link' : ' is-broken'}`}
        data-project-dir={entry.dir}
        onClick={usable && !editing ? () => onOpen(entry.dir) : undefined}
      >
        <div role="cell" className="tt-cell tt-name">
          <span className="tt-glyph">
            <ProjectIcon />
          </span>
          <span className="tt-name-text">
            {editing ? (
              <InlineName
                initial={entry.name}
                label={s('renameProject')}
                placeholder={s('renamePlaceholder')}
                onSave={(raw) => void saveRename(entry, raw)}
                onCancel={() => setRenaming(null)}
              />
            ) : usable ? (
              <button
                type="button"
                className="tt-title tt-title-btn"
                data-tt-primary
                onClick={(e) => {
                  e.stopPropagation()
                  onOpen(entry.dir)
                }}
              >
                {entry.name}
              </button>
            ) : (
              <span className="tt-title">{entry.name}</span>
            )}
            <span className="tt-sub" title={entry.dir}>
              {middleEllipsis(entry.dir, 64)}
            </span>
          </span>
        </div>
        {usable ? (
          <>
            <div role="cell" className="tt-cell tt-lang">
              <span className="translate-chip">
                {languageName(lang, entry.sourceLang)} {'→'} {languageName(lang, entry.targetLang)}
              </span>
            </div>
            <div role="cell" className="tt-cell tt-count">
              {entry.sourceCount}
            </div>
            <div role="cell" className="tt-cell tt-count">
              {entry.referenceCount}
            </div>
            <div
              role="cell"
              className="tt-cell tt-time"
              title={entry.lastOpened > 0 ? new Date(entry.lastOpened).toLocaleString() : undefined}
            >
              {entry.lastOpened > 0 ? relativeTime(lang, entry.lastOpened, Date.now()) : ''}
            </div>
          </>
        ) : (
          <div role="cell" className="tt-cell tt-broken">
            <span className="projects-mark is-warning">
              {entry.status === 'not-found' ? s('statusNotFound') : s('statusInvalid')}
            </span>
          </div>
        )}
        <div role="cell" className="tt-cell tt-actions">
          <RowMenu label={s('moreActions', { name: entry.name })} items={items} disabled={busy} />
        </div>
      </div>
    )
  }

  const matched = projects
    ? filterProjects(
        sortProjects(projects, sort, lang),
        query,
        (entry) => `${languageName(lang, entry.sourceLang)} ${languageName(lang, entry.targetLang)}`,
      )
    : []
  const slice = paginate(matched, page, PROJECT_PAGE_SIZE)

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
          <div className="tt-toolbar">
            <input
              type="search"
              className="tt-search"
              data-project-search
              value={query}
              placeholder={s('searchProjects')}
              aria-label={s('searchProjects')}
              onChange={(e) => {
                setQuery(e.target.value)
                setPage(0)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query) {
                  e.stopPropagation()
                  setQuery('')
                  setPage(0)
                }
              }}
            />
          </div>
        )}
        {projects !== null && projects.length > 0 && matched.length === 0 && (
          <p className="translate-lede" role="status" data-no-matches>
            {s('noMatches', { query: query.trim() })}
          </p>
        )}
        {projects !== null && matched.length > 0 && (
          <div
            role="table"
            className="tt tt-projects"
            aria-label={s('title')}
            onKeyDown={moveRowFocus}
          >
            <div role="row" className="tt-head">
              {sortHeader('name', s('colName'))}
              <div role="columnheader" className="tt-col tt-lang">
                {s('colLanguages')}
              </div>
              <div role="columnheader" className="tt-col tt-count">
                {s('colDocuments')}
              </div>
              <div role="columnheader" className="tt-col tt-count">
                {s('colReferences')}
              </div>
              {sortHeader('lastOpened', s('colLastOpened'), ' tt-time')}
              <div role="columnheader" className="tt-col tt-actions" aria-hidden="true" />
            </div>
            {slice.items.map(renderRow)}
          </div>
        )}
        {slice.pageCount > 1 && (
          <nav className="tt-pager" aria-label={s('title')} data-project-pager>
            <span className="tt-pager-status" role="status">
              {s('pageStatus', { from: slice.from, to: slice.to, total: slice.total })}
            </span>
            <button
              type="button"
              className="projects-ghost"
              disabled={slice.page === 0}
              onClick={() => setPage(slice.page - 1)}
            >
              {s('pagePrev')}
            </button>
            <button
              type="button"
              className="projects-ghost"
              disabled={slice.page >= slice.pageCount - 1}
              onClick={() => setPage(slice.page + 1)}
            >
              {s('pageNext')}
            </button>
          </nav>
        )}

        {recent.length > 0 && (
          <section className="translate-recent" data-recent-list>
            <h3 className="translate-section-title">{s('recentTitle')}</h3>
            <div
              role="table"
              className="tt tt-recent"
              aria-label={s('recentTitle')}
              onKeyDown={moveRowFocus}
            >
              <div role="row" className="tt-head">
                <div role="columnheader" className="tt-col">
                  {s('colName')}
                </div>
                <div role="columnheader" className="tt-col tt-proj">
                  {s('title')}
                </div>
                <div role="columnheader" className="tt-col tt-lang">
                  {s('colLanguages')}
                </div>
                <div role="columnheader" className="tt-col tt-time">
                  {s('colLastOpened')}
                </div>
                <div role="columnheader" className="tt-col tt-actions" aria-hidden="true" />
              </div>
              {recent.map((doc) => (
                <div
                  key={`${doc.dir}\n${doc.file}`}
                  role="row"
                  className={`tt-row${doc.available ? ' is-link' : ' is-broken'}`}
                  data-recent-file={doc.file}
                  onClick={
                    doc.available
                      ? () => {
                          setError(null)
                          void onOpenRecent?.(doc.dir, doc.file).catch(fail)
                        }
                      : undefined
                  }
                >
                  <div role="cell" className="tt-cell tt-name">
                    <span className="tt-glyph">
                      <FileIcon glyph={glyphForFile(doc.file)} />
                    </span>
                    <span className="tt-name-text">
                      {doc.available ? (
                        <button
                          type="button"
                          className="tt-title tt-title-btn"
                          data-tt-primary
                          onClick={(e) => {
                            e.stopPropagation()
                            setError(null)
                            void onOpenRecent?.(doc.dir, doc.file).catch(fail)
                          }}
                        >
                          {doc.file}
                        </button>
                      ) : (
                        <span className="tt-title">{doc.file}</span>
                      )}
                      {!doc.available && (
                        <span className="tt-sub">
                          <span className="projects-mark is-warning">{s('recentUnavailable')}</span>
                        </span>
                      )}
                    </span>
                  </div>
                  <div role="cell" className="tt-cell tt-proj">
                    {doc.projectName}
                  </div>
                  <div role="cell" className="tt-cell tt-lang">
                    <span className="translate-chip">
                      {languageName(lang, doc.sourceLang)} {'→'}{' '}
                      {languageName(lang, doc.targetLang)}
                    </span>
                  </div>
                  <div role="cell" className="tt-cell tt-time">
                    {relativeTime(lang, doc.openedAt, Date.now())}
                  </div>
                  <div role="cell" className="tt-cell tt-actions">
                    <RowMenu
                      label={s('moreActions', { name: doc.file })}
                      items={[
                        {
                          key: 'forget',
                          label: s('removeFromList'),
                          onSelect: () => void forgetRecent(doc.dir, doc.file),
                        },
                      ]}
                    />
                  </div>
                </div>
              ))}
            </div>
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
