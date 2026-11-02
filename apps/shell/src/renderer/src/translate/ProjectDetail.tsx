import { useCallback, useEffect, useRef, useState } from 'react'
import { LANGS } from '@genoffice/i18n'
import type { OcrMode, ProjectFile } from '@genoffice/translate-project'
import type { TranslateMaterialKind } from '../../../shared/translate-api'
import { useI18n } from '../locale'
import type { TranslateStringKey } from '../i18n/strings-translate'
import { languageName, makeText, translateErrorText } from './shared'
import '../projects-panel.css'
import './translate.css'
import './translate-global'

export interface ProjectDetailProps {
  dir: string
  onBack: () => void
  /** called with the first source file's name when the person starts a translation */
  onStartTranslation: (sourceFile: string) => void
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

function filesOf(project: ProjectFile, kind: TranslateMaterialKind): string[] {
  if (kind === 'source') return project.sources.map((e) => e.file)
  return kind === 'reference' ? project.references : project.glossaryFiles
}

/** One translation project: three separate upload lists, prompt, OCR and the start button. */
export function ProjectDetail({ dir, onBack, onStartTranslation }: ProjectDetailProps) {
  const { lang } = useI18n()
  const s = makeText(lang)
  const api = window.translateApi
  const [project, setProject] = useState<ProjectFile | null>(null)
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // the newest project object, so a blur-save never writes a stale list over an upload
  const latest = useRef<ProjectFile | null>(null)

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per project
  }, [dir])

  if (!api) return <main className="content projects-panel" />

  const save = async (patch: Partial<ProjectFile>) => {
    const base = latest.current
    if (!base) return
    const next = { ...base, ...patch }
    try {
      await api.saveProject(dir, next)
      adopt(next)
    } catch (err) {
      setError(translateErrorText(lang, err))
    }
  }

  const upload = async (kind: TranslateMaterialKind) => {
    setBusy(true)
    setError(null)
    try {
      const picked = await api.pickMaterials(kind)
      if (!picked) return
      for (let index = 0; index < picked.names.length; index += 1) {
        adopt(await api.addMaterial({ dir, kind, token: picked.token, index }))
      }
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
      adopt(await api.removeMaterial({ dir, kind, file }))
    } catch (err) {
      setError(translateErrorText(lang, err))
    } finally {
      setBusy(false)
    }
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

  const firstSource = project?.sources[0]?.file

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
                          </div>
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
                onChange={(e) => setPrompt(e.target.value)}
                onBlur={() => {
                  if (prompt !== latest.current?.projectPrompt) void save({ projectPrompt: prompt })
                }}
              />
              <span className="projects-hint">{s('promptHint')}</span>
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
                disabled={!firstSource}
                title={firstSource ? undefined : s('startDisabledHint')}
                onClick={() => firstSource && onStartTranslation(firstSource)}
              >
                {s('startTranslation')}
              </button>
            </div>
          </>
        )}
      </div>
    </main>
  )
}
