import { useCallback, useEffect, useRef, useState } from 'react'
import { LANGS } from '@genoffice/i18n'
import type { OcrMode, ProjectFile } from '@genoffice/translate-project'
import type {
  TranslateMaterialKind,
  TranslateReferenceStatus,
  TranslateReferenceText,
  TranslateSettingsPatch,
} from '../../../shared/translate-api'
import { useI18n } from '../locale'
import type { TranslateStringKey } from '../i18n/strings-translate'
import { languageName, makeText, translateErrorText } from './shared'
import '../projects-panel.css'
import './translate.css'
import './translate-global'

export interface ProjectDetailProps {
  dir: string
  onBack: () => void
  /** called with the source file's name when the person opens a translation */
  onStartTranslation: (sourceFile: string) => void
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

function filesOf(project: ProjectFile, kind: TranslateMaterialKind): string[] {
  if (kind === 'source') return project.sources.map((e) => e.file)
  return kind === 'reference' ? project.references : project.glossaryFiles
}

/** One translation project: three separate upload lists, prompt, OCR and the start button. */
export function ProjectDetail({
  dir,
  onBack,
  onStartTranslation,
  startNotice,
  listsVersion = 0,
}: ProjectDetailProps) {
  const { lang } = useI18n()
  const s = makeText(lang)
  const api = window.translateApi
  const [project, setProject] = useState<ProjectFile | null>(null)
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [promptFailed, setPromptFailed] = useState(false)
  const [promptSaved, setPromptSaved] = useState(false)
  // the newest project object, so a blur-save never writes a stale list over an upload
  const latest = useRef<ProjectFile | null>(null)
  // each reference's conversion status; null until main answered
  const [refStatus, setRefStatus] = useState<Record<string, TranslateReferenceStatus> | null>(null)
  const [viewing, setViewing] = useState<({ file: string } & TranslateReferenceText) | null>(null)
  const refStatusAsk = useRef(0)

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
    adopt({
      ...base,
      projectPrompt: next.projectPrompt,
      ocr: next.ocr,
      sourceLang: next.sourceLang,
      targetLang: next.targetLang,
    })
  }

  const adoptLists = (next: ProjectFile) => {
    const base = latest.current
    if (!base) return
    adopt({
      ...base,
      sources: next.sources,
      references: next.references,
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

  const save = async (patch: TranslateSettingsPatch): Promise<boolean> => {
    try {
      adoptSettings(await api.updateSettings({ dir, patch }))
      return true
    } catch (err) {
      setError(translateErrorText(lang, err))
      return false
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

  // the global button needs exactly one source; with several each row opens its own
  const onlySource = project?.sources.length === 1 ? project.sources[0]?.file : undefined
  const hasManySources = (project?.sources.length ?? 0) > 1

  return (
    <main className="content projects-panel">
      <div className="translate-pane">
        <div className="projects-head">
          <button type="button" className="projects-small" onClick={onBack}>
            {s('backToList')}
          </button>
          <h2 className="projects-title">{project?.name ?? s('loading')}</h2>
        </div>

        {error && (
          <div className="projects-note is-warning translate-error" role="alert">
            {error}
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
            <section className="translate-section" aria-label={s('languagePair')}>
              <div className="translate-lang-row">
                {languageSelect(project.sourceLang, s('sourceLangLabel'), 'sourceLang')}
                {languageSelect(project.targetLang, s('targetLangLabel'), 'targetLang')}
              </div>
            </section>

            {SECTIONS.map(({ kind, title }) => {
              const files = filesOf(project, kind)
              return (
                <section
                  key={kind}
                  className="translate-section"
                  aria-label={s(title)}
                  data-material-kind={kind}
                >
                  <h3 className="projects-group-title">{s(title)}</h3>
                  {files.length === 0 ? (
                    <p className="projects-empty">{s('noFiles')}</p>
                  ) : (
                    <ul className="projects-list">
                      {files.map((file) => (
                        <li key={file} className="projects-row">
                          <div className="translate-row-main">
                            <span className="projects-row-name">{file}</span>
                            {kind === 'reference' && referenceStatusOf(file)}
                            {kind === 'reference' && refStatus?.[file] === 'needs-ocr' && (
                              <span className="projects-hint translate-ref-hint">
                                {s('refNeedsOcrHint')}
                              </span>
                            )}
                            {kind === 'source' && pdfKindOf(project, file) && (
                              <span
                                className="translate-kind"
                                data-source-kind={pdfKindOf(project, file)}
                              >
                                {pdfKindOf(project, file) === 'scan' ? s('kindScan') : s('kindPdf')}
                              </span>
                            )}
                          </div>
                          {kind === 'source' && pdfKindOf(project, file) && (
                            <button
                              type="button"
                              className="projects-small"
                              data-action="toggle-pdf-kind"
                              disabled={busy}
                              onClick={() =>
                                void setPdfKind(
                                  file,
                                  pdfKindOf(project, file) === 'scan' ? 'pdf' : 'scan',
                                )
                              }
                            >
                              {pdfKindOf(project, file) === 'scan'
                                ? s('treatAsText')
                                : s('treatAsScan')}
                            </button>
                          )}
                          {kind === 'reference' && refStatus?.[file] === 'converted' && (
                            <button
                              type="button"
                              className="projects-small"
                              data-action="view-converted"
                              aria-label={`${s('viewConverted')}: ${file}`}
                              onClick={() => void viewConverted(file)}
                            >
                              {s('viewConverted')}
                            </button>
                          )}
                          {kind === 'source' && (
                            <button
                              type="button"
                              className="projects-small"
                              aria-label={`${s('openTranslation')}: ${file}`}
                              onClick={() => onStartTranslation(file)}
                            >
                              {s('openTranslation')}
                            </button>
                          )}
                          <button
                            type="button"
                            className="projects-small"
                            aria-label={s('deleteFileAria', { name: file })}
                            disabled={busy}
                            onClick={() => void removeFile(kind, file)}
                          >
                            {s('deleteFile')}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <button
                    type="button"
                    className="projects-ghost"
                    disabled={busy}
                    onClick={() => void upload(kind)}
                  >
                    {s('addFiles')}
                  </button>
                </section>
              )
            })}

            <label className="projects-field translate-section">
              <span className="projects-field-label">{s('promptLabel')}</span>
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
              {promptSaved && !promptFailed && (
                <span className="projects-hint" role="status">
                  {s('saved')}
                </span>
              )}
              {promptFailed && (
                <span className="projects-hint" role="status">
                  {s('promptNotSaved')}
                </span>
              )}
            </label>

            <label className="projects-field translate-section">
              <span className="projects-field-label">{s('ocrLabel')}</span>
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

            <div className="projects-buttons">
              <button
                type="button"
                className="projects-primary"
                disabled={!onlySource}
                onClick={() => onlySource && onStartTranslation(onlySource)}
              >
                {s('startTranslation')}
              </button>
              {!onlySource && (
                <span className="projects-hint">
                  {hasManySources ? s('startPickHint') : s('startDisabledHint')}
                </span>
              )}
            </div>
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
}
