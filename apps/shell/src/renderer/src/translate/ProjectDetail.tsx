import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { LANGS } from '@genoffice/i18n'
import type { OcrMode, ProjectFile } from '@genoffice/translate-project'
import type {
  TranslateMaterialKind,
  TranslatePictureInfo,
  TranslateReferenceStatus,
  TranslateReferenceText,
  TranslateSettingsPatch,
} from '../../../shared/translate-api'
import { useI18n } from '../locale'
import { useWikiFinalLearning } from './useWikiFinalLearning'
import { TranslationWikiButton, useTranslationWiki } from './TranslationWiki'
import { ProjectAssistant, type ProjectAssistantProps } from './ProjectAssistant'
import type { TranslateStringKey } from '../i18n/strings-translate'
import { normalizeProjectName } from '../../../shared/project-name'
import { ProjectBatchControl } from './ProjectBatch'
import { InlineName } from './InlineName'
import {
  EyeIcon,
  FileIcon,
  glyphForFile,
  OpenIcon,
  PencilIcon,
  SaveAsIcon,
  ScanIcon,
  SwapIcon,
  TrashIcon,
} from './icons'
import { saveAsNoticeFor, type SaveAsNotice } from './save-as-action'
import { DEFAULT_WRITING_STYLE, WritingStyleCard } from './WritingStyleCard'
import { TranslationChoicesCard } from './TranslationChoicesCard'
import { languageName, makeText, translateErrorText } from './shared'
import '../projects-panel.css'
import './translate.css'
import './translate-global'

export interface ProjectDetailProps {
  assistant?: Omit<ProjectAssistantProps, 'actions'> & { open(file: string): Promise<string> }

  dir: string
  onBack: () => void
  /** called with the source file's name when the person opens a translation */
  onStartTranslation: (sourceFile: string) => void
  /** Read embedded DOCX/XLSX images without opening the editable translation. */
  onStartOcr?: (sourceFile: string) => void
  /** what opening the translation view reported (an error, or the changed-source warning) */
  startNotice?: { text: string; isError: boolean } | null
  /** bumped when the source list may have changed elsewhere (a PDF found to be a scan) */
  listsVersion?: number
}

type OcrChoice = 'claude' | 'chatgpt' | 'off'

function ocrChoice(ocr: OcrMode): OcrChoice {
  return ocr.kind === 'off' ? 'off' : ocr.provider
}

function ocrMode(choice: OcrChoice): OcrMode {
  return choice === 'off' ? { kind: 'off' } : { kind: 'ai', provider: choice }
}

const SECTIONS: { kind: TranslateMaterialKind; title: TranslateStringKey }[] = [
  { kind: 'source', title: 'sourcesTitle' },
  { kind: 'reference', title: 'referencesTitle' },
  { kind: 'glossary', title: 'glossaryTitle' },
]

/** 'pdf' or 'scan' for a PDF source, else null (only those two can be switched) */
function pdfKindOf(project: ProjectFile, file: string): 'pdf' | 'scan' | null {
  const kind = project.sources.find((e) => e.file === file)?.kind
  return kind === 'pdf' || kind === 'scan' ? kind : null
}

const REFERENCE_STATUS_TEXT: Record<TranslateReferenceStatus, TranslateStringKey> = {
  converted: 'refConverted',
  'needs-ocr': 'refNeedsOcr',
  failed: 'refFailed',
  unsupported: 'refUnsupported',
  outside: 'refOutside',
}

/** the key of one file's picture count: kind and name */
function pictureKey(kind: TranslatePictureInfo['kind'], file: string): string {
  return `${kind}\u0000${file}`
}

function filesOf(project: ProjectFile, kind: TranslateMaterialKind): string[] {
  if (kind === 'source') return project.sources.map((e) => e.file)
  return kind === 'reference' ? project.references : project.glossaryFiles
}

/** One translation project: three separate upload lists, prompt, OCR and the start button. */
/** the sources whose pictures OCR can read: embedded in Word and Excel, taken out of Hangul documents */
const OCR_PICTURE_FILE = /\.(docx|xlsx|hwpx|hwp)$/i

export function ProjectDetail(props: ProjectDetailProps) {
  return <ProjectContent key={props.dir} {...props} />
}

function ProjectContent({
  assistant,
  dir,
  onBack,
  onStartTranslation,
  onStartOcr,
  startNotice,
  listsVersion = 0,
}: ProjectDetailProps) {
  const { lang } = useI18n()
  const s = makeText(lang)
  const wiki = useTranslationWiki()
  const learning = useWikiFinalLearning(dir)
  const api = window.translateApi
  const [project, setProject] = useState<ProjectFile | null>(null)
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pendingWikiSetting, setPendingWikiSetting] = useState<boolean | null>(null)
  const [exportMessage, setExportMessage] = useState<SaveAsNotice | null>(null)
  const [promptFailed, setPromptFailed] = useState(false)
  const [promptSaved, setPromptSaved] = useState(false)
  const [renamingTitle, setRenamingTitle] = useState(false)
  const [titleSaved, setTitleSaved] = useState(false)
  // the newest project object, so a blur-save never writes a stale list over an upload
  const latest = useRef<ProjectFile | null>(null)
  // each reference's conversion status; null until main answered
  const [refStatus, setRefStatus] = useState<Record<string, TranslateReferenceStatus> | null>(null)
  const [viewing, setViewing] = useState<({ file: string } & TranslateReferenceText) | null>(null)
  const refStatusAsk = useRef(0)
  // embedded pictures per source and reference; absent: none, unknown or not asked yet
  const [pictures, setPictures] = useState<Map<string, number>>(new Map())
  const picturesAsk = useRef(0)

  /** ask main how many pictures each file embeds; a failure only means no notice */
  const loadPictures = useCallback(() => {
    if (typeof api?.pictureInfo !== 'function') return
    const ask = ++picturesAsk.current
    api.pictureInfo(dir).then(
      (list) => {
        if (ask !== picturesAsk.current) return
        const next = new Map<string, number>()
        for (const item of list)
          if (typeof item.pictures === 'number' && item.pictures > 0)
            next.set(pictureKey(item.kind, item.file), item.pictures)
        setPictures(next)
      },
      // a failed ask drops what an earlier one said: it may name a removed or replaced file
      () => {
        if (ask === picturesAsk.current) setPictures(new Map())
      },
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per project
  }, [dir])

  /** ask main for the statuses (it converts what its index does not know yet) */
  const loadRefStatus = useCallback(() => {
    if (!api) return
    const ask = ++refStatusAsk.current
    api.referenceStatus(dir).then(
      (statuses) => {
        if (ask === refStatusAsk.current) setRefStatus(statuses)
      },
      () => undefined,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per project
  }, [dir])

  const adopt = useCallback((next: ProjectFile) => {
    latest.current = next
    setProject(next)
  }, [])

  useEffect(() => {
    if (!api) return
    api.getProject(dir).then(
      (loaded) => {
        adopt(loaded)
        setPrompt(loaded.projectPrompt)
      },
      (err: unknown) => setError(translateErrorText(lang, err)),
    )
    loadRefStatus()
    loadPictures()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per project
  }, [dir])

  // a source's kind may have changed in main (scan detection): read the lists again
  useEffect(() => {
    if (!api || listsVersion === 0) return
    let alive = true
    api.getProject(dir).then(
      (loaded) => {
        const base = latest.current
        if (alive && base) adopt({ ...base, sources: loaded.sources })
      },
      () => undefined,
    )
    loadPictures()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload on each bump
  }, [listsVersion])

  if (!api) return <main className="content projects-panel" />

  // Settings responses own only the four settings fields and material responses own
  // only the lists, so neither can roll back the other while both are in flight.
  const adoptSettings = (next: ProjectFile) => {
    const base = latest.current
    if (!base) return
    const merged: ProjectFile = {
      ...base,
      projectPrompt: next.projectPrompt,
      useWiki: next.useWiki,
      ocr: next.ocr,
      writingStyle: next.writingStyle,
      sourceLang: next.sourceLang,
      targetLang: next.targetLang,
    }
    // absent means "nothing kept": a reset must not leave the old set behind
    if (next.choices) merged.choices = next.choices
    else delete merged.choices
    adopt(merged)
  }

  const adoptLists = (next: ProjectFile) => {
    const base = latest.current
    if (!base) return
    adopt({
      ...base,
      sources: next.sources,
      references: next.references,
      wikiReferences: next.wikiReferences,
      glossaryFiles: next.glossaryFiles,
    })
  }

  const savePrompt = () => {
    if (prompt === latest.current?.projectPrompt) {
      setPromptSaved(true)
      return
    }
    void save({ projectPrompt: prompt }).then((ok) => {
      setPromptFailed(!ok)
      setPromptSaved(ok)
    })
  }

  /** change the display name only; the folder on disk keeps its name */
  const saveTitle = async (raw: string) => {
    setRenamingTitle(false)
    const next = normalizeProjectName(raw)
    if (next === null) {
      setError(s('renameInvalid'))
      return
    }
    if (next === latest.current?.name) return
    setError(null)
    try {
      const renamed = await api.rename({ dir, name: next })
      const base = latest.current
      if (base) adopt({ ...base, name: renamed.name })
      setTitleSaved(true)
    } catch (err) {
      setError(translateErrorText(lang, err))
    }
  }

  const save = async (patch: TranslateSettingsPatch): Promise<boolean> => {
    try {
      adoptSettings(await api.updateSettings({ dir, patch }))
      return true
    } catch (err) {
      setError(translateErrorText(lang, err))
      return false
    }
  }

  const chooseWikiReferences = async () => {
    setBusy(true)
    setError(null)
    try {
      const updated = await api.addWikiReferences(dir)
      if (updated) {
        adoptLists(updated)
        loadRefStatus()
      }
    } catch (err) {
      setError(translateErrorText(lang, err))
      // Reflect any copies already saved before a later note failed.
      await api.getProject(dir).then(adoptLists, () => {})
      loadRefStatus()
    } finally {
      setBusy(false)
    }
  }

  const upload = async (kind: TranslateMaterialKind) => {
    setBusy(true)
    setError(null)
    try {
      const picked = await api.pickMaterials(kind)
      if (!picked) return
      const added: string[] = []
      try {
        for (let index = 0; index < picked.names.length; index += 1) {
          adoptLists(await api.addMaterial({ dir, kind, token: picked.token, index }))
          added.push(picked.names[index] ?? '')
        }
      } catch (err) {
        const detail = added.length > 0 ? ` ${s('uploadPartial', { files: added.join(', ') })}` : ''
        setError(translateErrorText(lang, err) + detail)
      }
      if (kind === 'reference' && added.length > 0) loadRefStatus()
      if (kind !== 'glossary' && added.length > 0) loadPictures()
    } catch (err) {
      setError(translateErrorText(lang, err))
    } finally {
      setBusy(false)
    }
  }

  /** the person's correction: a PDF is a text PDF or a scan */
  const setPdfKind = async (file: string, kind: 'pdf' | 'scan') => {
    setBusy(true)
    setError(null)
    try {
      adoptLists(await api.setSourceKind({ dir, file, kind }))
    } catch (err) {
      setError(translateErrorText(lang, err))
    } finally {
      setBusy(false)
    }
  }

  const removeFile = async (kind: TranslateMaterialKind, file: string) => {
    setBusy(true)
    setError(null)
    try {
      adoptLists(await api.removeMaterial({ dir, kind, file }))
      if (kind === 'reference') loadRefStatus()
      if (kind !== 'glossary') loadPictures()
    } catch (err) {
      setError(translateErrorText(lang, err))
    } finally {
      setBusy(false)
    }
  }

  /** the converted text of a reference, shown read-only */
  const viewConverted = async (file: string) => {
    setError(null)
    try {
      setViewing({ file, ...(await api.referenceText({ dir, file })) })
    } catch (err) {
      setError(translateErrorText(lang, err))
    }
  }

  const referenceStatusOf = (file: string) => {
    const status = refStatus?.[file]
    return (
      <span
        className="translate-kind"
        data-reference-status={status ?? 'checking'}
        data-file={file}
      >
        {status ? s(REFERENCE_STATUS_TEXT[status]) : s('refChecking')}
      </span>
    )
  }

  /** text inside pictures is not translated: say so, and what the person can do */
  const pictureNotice = (kind: TranslateMaterialKind, file: string) => {
    if (kind === 'glossary') return null
    const count = pictures.get(pictureKey(kind, file))
    if (!count) return null
    return (
      <span
        className="translate-ref-hint translate-note translate-picture-hint"
        role="note"
        data-picture-notice={count}
        data-file={file}
      >
        {s(
          kind === 'source' && OCR_PICTURE_FILE.test(file)
            ? 'pictureHintEmbedded'
            : kind === 'source'
              ? 'pictureHintSource'
              : 'pictureHintReference',
          { count },
        )}
      </span>
    )
  }

  const languageSelect = (value: string, label: string, key: 'sourceLang' | 'targetLang') => (
    <label className="projects-field">
      <span className="projects-field-label">{label}</span>
      <select
        className="translate-select"
        value={value}
        onChange={(e) => void save({ [key]: e.target.value })}
      >
        {!LANGS.some((code) => code === value) && <option value={value}>{value}</option>}
        {LANGS.map((code) => (
          <option key={code} value={code}>
            {languageName(lang, code)}
          </option>
        ))}
      </select>
    </label>
  )

  /** copy this source's saved translation to a place the person picks */
  const saveAsSource = async (file: string): Promise<void> => {
    if (!api) return
    const notice = await saveAsNoticeFor(lang, api, { dir, file })
    setExportMessage(notice)
  }

  // the global button needs exactly one source; with several each row opens its own
  const onlySource = project?.sources.length === 1 ? project.sources[0]?.file : undefined
  const offersBatch = typeof api?.batchStart === 'function'
  const hasManySources = (project?.sources.length ?? 0) > 1

  /** icon-only row action with its name as tooltip and accessible label */
  const rowAction = (
    action: string,
    label: string,
    icon: ReactNode,
    onClick: () => void,
    options: { disabled?: boolean; danger?: boolean } = {},
  ) => (
    <button
      type="button"
      className={`tt-icon-btn${options.danger ? ' is-danger' : ''}`}
      data-action={action}
      aria-label={label}
      title={label}
      disabled={options.disabled}
      onClick={onClick}
    >
      {icon}
    </button>
  )

  const renderFileRow = (project: ProjectFile, kind: TranslateMaterialKind, file: string) => {
    const pdfKind = kind === 'source' ? pdfKindOf(project, file) : null
    const picture = pictureNotice(kind, file)
    const needsOcr = kind === 'reference' && refStatus?.[file] === 'needs-ocr'
    const ext = file.includes('.') ? (file.split('.').pop() ?? '').toUpperCase() : ''
    return (
      <div key={file} role="row" className="tt-row" data-file={file}>
        <div role="cell" className="tt-cell tt-name">
          <span className="tt-glyph">
            <FileIcon glyph={kind === 'glossary' ? 'glossary' : glyphForFile(file)} />
          </span>
          <span className="tt-name-text">
            {kind === 'source' ? (
              <button
                type="button"
                className="tt-title tt-link"
                data-action="open-title"
                title={s('openTranslation')}
                onClick={() => onStartTranslation(file)}
              >
                {file}
              </button>
            ) : (
              <span className="tt-title">{file}</span>
            )}
            {picture ?? (
              <span className="tt-sub">
                {needsOcr ? <span className="translate-note">{s('refNeedsOcrHint')}</span> : ext}
              </span>
            )}
          </span>
        </div>
        <div role="cell" className="tt-cell tt-status">
          {kind === 'reference' ? (
            referenceStatusOf(file)
          ) : pdfKind ? (
            <span className="translate-kind" data-source-kind={pdfKind}>
              {pdfKind === 'scan' ? s('kindScan') : s('kindPdf')}
            </span>
          ) : (
            <span className="translate-kind" data-status="ready">
              {s('statusReady')}
            </span>
          )}
        </div>
        <div role="cell" className="tt-cell tt-actions">
          {kind === 'source' &&
            onStartOcr &&
            OCR_PICTURE_FILE.test(file) &&
            rowAction(
              'embedded-ocr',
              `${s('ocrTitle')}: ${file}`,
              <ScanIcon />,
              () => onStartOcr(file),
              { disabled: busy },
            )}
          {pdfKind &&
            rowAction(
              'toggle-pdf-kind',
              pdfKind === 'scan' ? s('treatAsText') : s('treatAsScan'),
              <SwapIcon />,
              () => void setPdfKind(file, pdfKind === 'scan' ? 'pdf' : 'scan'),
              { disabled: busy },
            )}
          {kind === 'reference' &&
            refStatus?.[file] === 'converted' &&
            rowAction(
              'view-converted',
              `${s('viewConverted')}: ${file}`,
              <EyeIcon />,
              () => void viewConverted(file),
            )}
          {kind === 'source' &&
            rowAction(
              'save-as-translation',
              `${s('saveAsTranslation')}: ${file}`,
              <SaveAsIcon />,
              () => void saveAsSource(file),
              { disabled: busy },
            )}
          {kind === 'source' &&
            rowAction('open-translation', `${s('openTranslation')}: ${file}`, <OpenIcon />, () =>
              onStartTranslation(file),
            )}
          {rowAction(
            'delete-file',
            s('deleteFileAria', { name: file }),
            <TrashIcon />,
            () => void removeFile(kind, file),
            { disabled: busy, danger: true },
          )}
        </div>
      </div>
    )
  }

  const detail = (
    <main className="content projects-panel">
      <div className="translate-pane">
        <button type="button" className="translate-back" onClick={onBack}>
          <span aria-hidden="true">{'←'}</span> {s('backToList')}
        </button>
        <header className="translate-head">
          <div className="translate-head-text">
            {renamingTitle && project ? (
              <h2 className="translate-title is-editing">
                <InlineName
                  initial={project.name}
                  label={s('renameProject')}
                  placeholder={s('renamePlaceholder')}
                  onSave={(raw) => void saveTitle(raw)}
                  onCancel={() => setRenamingTitle(false)}
                />
              </h2>
            ) : (
              <h2 className="translate-title">
                <span
                  className={project ? 'translate-title-text is-editable' : undefined}
                  onClick={project ? () => setRenamingTitle(true) : undefined}
                >
                  {project?.name ?? s('loading')}
                </span>
              </h2>
            )}
            {project && !renamingTitle && (
              <button
                type="button"
                className="tt-icon-btn translate-title-edit"
                data-action="rename-title"
                title={s('renameProject')}
                aria-label={s('renameProject')}
                onClick={() => setRenamingTitle(true)}
              >
                <PencilIcon />
              </button>
            )}
            {titleSaved && !renamingTitle && (
              <span className="translate-saved" role="status" data-rename-saved>
                {s('saved')}
              </span>
            )}
            {project && (
              <span className="translate-chip">
                {languageName(lang, project.sourceLang)} {'→'}{' '}
                {languageName(lang, project.targetLang)}
              </span>
            )}
          </div>
          {project && (
            <div className="translate-head-actions">
              {(!offersBatch || !hasManySources) && (
                <button
                  type="button"
                  className="projects-primary"
                  disabled={!onlySource}
                  onClick={() => onlySource && onStartTranslation(onlySource)}
                >
                  {s('startTranslation')}
                </button>
              )}
              {offersBatch && api && (
                <ProjectBatchControl
                  api={api}
                  key={dir}
                  dir={dir}
                  files={project.sources.map((source) => source.file)}
                  primary={hasManySources}
                  wikiAvailable={project.useWiki !== false}
                />
              )}
              {learning.button}
              <TranslationWikiButton />
            </div>
          )}
        </header>
        {learning.report}
        {project && !onlySource && (!offersBatch || !hasManySources) && (
          <p className="translate-start-hint">
            {hasManySources ? s('startPickHint') : s('startDisabledHint')}
          </p>
        )}

        {error && (
          <div className="projects-note is-warning translate-error" role="alert">
            {error}
          </div>
        )}
        {exportMessage && (
          <div
            className={`projects-note translate-error${exportMessage.isError ? ' is-warning' : ''}`}
            role={exportMessage.isError ? 'alert' : 'status'}
            data-export-notice
          >
            {exportMessage.text}
          </div>
        )}
        {startNotice && (
          <div
            className="projects-note is-warning translate-error"
            role={startNotice.isError ? 'alert' : 'status'}
          >
            {startNotice.text}
          </div>
        )}

        {project && (
          <>
            <div className="tt-settings">
              <section className="translate-card-section" aria-label={s('languagePair')}>
                <h3 className="translate-section-title">{s('languagePair')}</h3>
                <div className="translate-lang-row">
                  {languageSelect(project.sourceLang, s('sourceLangLabel'), 'sourceLang')}
                  {languageSelect(project.targetLang, s('targetLangLabel'), 'targetLang')}
                </div>
              </section>
              <label className="projects-field translate-card-section">
                <span className="translate-section-title">{s('ocrLabel')}</span>
                <select
                  className="translate-select"
                  aria-label={s('ocrLabel')}
                  value={ocrChoice(project.ocr)}
                  onChange={(e) => void save({ ocr: ocrMode(e.target.value as OcrChoice) })}
                >
                  <option value="claude">{s('ocrClaude')}</option>
                  <option value="chatgpt">{s('ocrChatgpt')}</option>
                  <option value="off">{s('ocrOff')}</option>
                </select>
              </label>
            </div>

            {SECTIONS.map(({ kind, title }) => {
              const files = filesOf(project, kind)
              return (
                <section
                  key={kind}
                  className="translate-block"
                  aria-label={s(title)}
                  data-material-kind={kind}
                >
                  <div className="translate-section-head">
                    <h3 className="translate-section-title">
                      {s(title)}
                      <span className="translate-count">{files.length}</span>
                    </h3>
                    <div className="translate-material-actions">
                      {kind === 'reference' && (
                        <label className="translate-wiki-option">
                          <input
                            type="checkbox"
                            checked={pendingWikiSetting ?? project.useWiki !== false}
                            disabled={busy || pendingWikiSetting !== null}
                            onChange={(event) => {
                              const checked = event.target.checked
                              setPendingWikiSetting(checked)
                              void save({ useWiki: checked }).finally(() =>
                                setPendingWikiSetting(null),
                              )
                            }}
                          />
                          {s('useWiki')}
                        </label>
                      )}
                      {kind === 'reference' && (
                        <button
                          type="button"
                          className="projects-small translate-add"
                          disabled={busy}
                          onClick={() => void chooseWikiReferences()}
                        >
                          {s('selectWikiReferences')}
                        </button>
                      )}
                      <button
                        type="button"
                        className="projects-small translate-add"
                        disabled={busy}
                        onClick={() => void upload(kind)}
                      >
                        {s('addFiles')}
                      </button>
                    </div>
                  </div>
                  {files.length === 0 ? (
                    <p className="translate-none">{s('noFiles')}</p>
                  ) : (
                    <div role="table" className="tt tt-files" aria-label={s(title)}>
                      <div role="row" className="tt-head">
                        <div role="columnheader" className="tt-col">
                          {s('colName')}
                        </div>
                        <div role="columnheader" className="tt-col tt-status">
                          {s('colStatus')}
                        </div>
                        <div role="columnheader" className="tt-col tt-actions" aria-hidden="true" />
                      </div>
                      {files.map((file) => renderFileRow(project, kind, file))}
                    </div>
                  )}
                </section>
              )
            })}

            <label className="projects-field translate-card-section">
              <span className="translate-field-head">
                <span className="translate-section-title">{s('promptLabel')}</span>
                {promptSaved && !promptFailed && (
                  <span className="translate-saved" role="status">
                    {s('saved')}
                  </span>
                )}
                {promptFailed && (
                  <span className="translate-saved is-failed" role="status">
                    {s('promptNotSaved')}
                  </span>
                )}
              </span>
              <textarea
                className="projects-textarea"
                aria-label={s('promptLabel')}
                value={prompt}
                onChange={(e) => {
                  setPrompt(e.target.value)
                  setPromptSaved(false)
                }}
                onBlur={savePrompt}
              />
              <span className="projects-hint">{s('promptHint')}</span>
            </label>

            <WritingStyleCard
              style={project.writingStyle ?? DEFAULT_WRITING_STYLE}
              s={s}
              onSave={(writingStyle) => save({ writingStyle })}
            />

            <TranslationChoicesCard
              choices={project.choices}
              s={s}
              onSave={(choices) => save({ choices })}
            />
          </>
        )}
      </div>
      {viewing && (
        <div className="modal-overlay">
          <div
            className="modal translate-converted"
            role="dialog"
            aria-modal="true"
            aria-label={s('convertedTitle', { name: viewing.file })}
          >
            <h3>{s('convertedTitle', { name: viewing.file })}</h3>
            <p className="projects-hint">{s('convertedReadOnly')}</p>
            {viewing.truncated && <p className="projects-hint">{s('convertedTruncated')}</p>}
            {/* plain text in a <pre>: nothing here can be edited or written back */}
            <pre className="translate-converted-text">{viewing.text}</pre>
            <div className="modal-buttons">
              <button type="button" className="btn btn-secondary" onClick={() => setViewing(null)}>
                {s('trClose')}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
  return (
    <div className="translation-project-workspace">
      {detail}
      {assistant && project && (
        <ProjectAssistant
          key={dir}
          {...assistant}
          actions={{
            dir,
            api,
            project: () => latest.current ?? project,
            open: assistant.open,
            ocr: (file) => onStartOcr?.(file),
            confirmRemove: (file) => window.confirm(s('deleteFileAria', { name: file }) + '?'),
            wiki: () => {
              if (!wiki) throw new Error('Wiki unavailable')
              wiki.open()
            },
            refresh: async () => {
              const before = latest.current
              const updated = await api.getProject(dir)
              adopt(updated)
              if (before?.projectPrompt !== updated.projectPrompt) setPrompt(updated.projectPrompt)
              loadRefStatus()
              loadPictures()
            },
          }}
        />
      )}
    </div>
  )
}
