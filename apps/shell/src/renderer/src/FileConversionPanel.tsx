import { useEffect, useState } from 'react'
import type { FileConversionInput, FileConversionResult } from '../../shared/file-conversion'
import { translateText } from './i18n/strings-translate'
import { fileConversionText } from './i18n/strings-file-conversion'
import { useI18n } from './locale'
import { OcrPageRange } from './OcrPageRange'
import './file-conversion.css'

function commonTargets(files: FileConversionInput[]): string[] {
  return (
    files[0]?.targets.filter((format) => files.every((file) => file.targets.includes(format))) ?? []
  )
}

export function FileConversionPanel({
  visible,
  mode = 'convert',
}: {
  visible: boolean
  mode?: 'ocr' | 'convert'
}) {
  const { lang } = useI18n()
  const ocr = mode === 'ocr'
  const prefix = ocr ? 'ocr-files' : 'file-conversion'
  const api = ocr ? window.ocrFilesApi : window.fileConversionApi
  function errorDetail(message?: string) {
    if (message === 'OCR_PAGE_RANGE') return fileConversionText(lang, 'ocrRangeInvalid')
    if (message === 'OCR_NO_TEXT') return fileConversionText(lang, 'ocrNoText')
    if (message === 'OCR_LANGUAGE_UNAVAILABLE')
      return fileConversionText(lang, 'ocrLanguageUnavailable')
    if (message === 'OCR_UNAVAILABLE') return fileConversionText(lang, 'ocrUnavailable')
    if (message?.startsWith('OCR_')) return fileConversionText(lang, 'convertFailed')
    return message
  }
  const [files, setFiles] = useState<FileConversionInput[]>([])
  const [target, setTarget] = useState('')
  const [language, setLanguage] = useState('')
  const [installedLanguages, setInstalledLanguages] = useState<string[]>([])
  const [pageRange, setPageRange] = useState('')
  useEffect(() => {
    if (!ocr || !visible) return
    let active = true
    window.ocrFilesApi
      .languages()
      .then((tags) => {
        if (active) setInstalledLanguages(tags)
      })
      .catch(() => {
        if (active) setInstalledLanguages([])
      })
    return () => {
      active = false
    }
  }, [ocr, visible])
  const languageNames = ocr && visible ? new Intl.DisplayNames(lang, { type: 'language' }) : null
  const [results, setResults] = useState<Record<string, FileConversionResult>>({})
  const [activity, setActivity] = useState<'pick' | 'run' | null>(null)
  const [error, setError] = useState<'chooseFailed' | 'convertFailed' | null>(null)
  const targets = commonTargets(files)
  const pending = files.filter((file) => !results[file.id]?.outputPath)
  const busy = activity !== null

  function changeFiles(next: FileConversionInput[]) {
    const formats = commonTargets(next)
    const nextTarget = formats.includes(target) ? target : (formats[0] ?? '')
    setFiles(next)
    setTarget(nextTarget)
    setError(null)
    setResults((previous) =>
      target === nextTarget
        ? Object.fromEntries(
            next.filter((file) => previous[file.id]).map((file) => [file.id, previous[file.id]]),
          )
        : {},
    )
  }

  async function pickFiles(dropped?: File[]) {
    if (!api || busy) return
    setActivity('pick')
    setError(null)
    try {
      const picked = dropped ? await window.ocrFilesApi.drop(dropped) : await api.pick()
      if (picked.length > 0) {
        const knownIds = new Set(files.map((file) => file.id))
        changeFiles([...files, ...picked.filter((file) => !knownIds.has(file.id))])
      }
    } catch {
      setError('chooseFailed')
    } finally {
      setActivity(null)
    }
  }

  async function convert() {
    if (!api || busy || !target || !pending.length) return
    const ids = pending.map((file) => file.id)
    setActivity('run')
    setError(null)
    const unsubscribe = api.onProgress((result) => {
      setResults((previous) => ({ ...previous, [result.id]: result }))
    })
    try {
      const completed = ocr
        ? await window.ocrFilesApi.run(ids, target, {
            language: language || undefined,
            pageRange: pageRange || undefined,
          })
        : await api.run(ids, target)
      setResults((previous) => ({
        ...previous,
        ...Object.fromEntries(completed.map((result) => [result.id, result])),
      }))
    } catch {
      setError('convertFailed')
    } finally {
      unsubscribe()
      setActivity(null)
    }
  }

  if (!visible) return null

  return (
    <main
      className="content"
      data-testid={`${prefix}-panel`}
      onDragOver={
        ocr
          ? (event) => {
              if (event.dataTransfer.types.includes('Files')) event.preventDefault()
            }
          : undefined
      }
      onDrop={
        ocr
          ? (event) => {
              if (!event.dataTransfer.types.includes('Files')) return
              event.preventDefault()
              void pickFiles(Array.from(event.dataTransfer.files))
            }
          : undefined
      }
    >
      <section className="file-conversion-pane" aria-labelledby={`${prefix}-title`}>
        <header className="translate-head">
          <div className="translate-head-text">
            <h2 id={`${prefix}-title`} className="translate-title">
              {fileConversionText(lang, ocr ? 'ocrTitle' : 'title')}
            </h2>
            <p className="translate-lede">{fileConversionText(lang, 'destinationHint')}</p>
          </div>
        </header>
        <div className="projects-toolbar">
          <button
            type="button"
            className="projects-ghost"
            disabled={busy}
            onClick={() => void pickFiles()}
            data-testid={`${prefix}-pick`}
          >
            {files.length
              ? translateText(lang, 'addFiles')
              : fileConversionText(lang, 'chooseFiles')}
          </button>
        </div>
        {files.length > 0 && (
          <ul className="projects-list file-conversion-files" aria-live="polite">
            {files.map((file) => {
              const result = results[file.id]
              return (
                <li key={file.id} className="projects-row" data-testid={`${prefix}-file`}>
                  <div className="file-conversion-file">
                    <span className="file-conversion-name" title={file.displayPath}>
                      {file.name}
                    </span>
                    {result && (
                      <span
                        className="file-conversion-result"
                        data-failed={!result.outputPath || undefined}
                      >
                        {result.outputPath
                          ? fileConversionText(lang, 'saved') + ' · ' + result.outputPath
                          : [fileConversionText(lang, 'failed'), errorDetail(result.error)]
                              .filter(Boolean)
                              .join(' · ')}
                      </span>
                    )}
                    {result?.warning && (
                      <span className="file-conversion-result">{result.warning}</span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="projects-small file-conversion-remove"
                    aria-label={fileConversionText(lang, 'removeFile', { name: file.name })}
                    disabled={busy}
                    onClick={() => changeFiles(files.filter((other) => other.id !== file.id))}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                      <path
                        d="m3 3 6 6m0-6-6 6"
                        stroke="currentColor"
                        strokeWidth="1.4"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        {files.length > 0 && !targets.length && (
          <p className="projects-note is-warning" role="status">
            {fileConversionText(lang, 'noCommonFormat')}
          </p>
        )}
        {error && (
          <p className="projects-note is-warning" role="alert">
            {fileConversionText(lang, error)}
          </p>
        )}
        <div className="projects-buttons file-conversion-actions">
          {ocr && (
            <>
              <label className="projects-field">
                <span className="projects-field-label">
                  {fileConversionText(lang, 'ocrLanguage')}
                </span>
                <select
                  className="translate-select"
                  disabled={busy}
                  data-testid="ocr-files-language"
                  value={language}
                  onChange={(event) => {
                    setLanguage(event.target.value)
                    setResults({})
                    setError(null)
                  }}
                >
                  <option value="">{fileConversionText(lang, 'ocrLanguageDefault')}</option>
                  {installedLanguages.map((tag) => (
                    <option key={tag} value={tag}>
                      {languageNames?.of(tag) ?? tag}
                    </option>
                  ))}
                  {language && !installedLanguages.includes(language) && (
                    <option value={language} disabled>
                      {languageNames?.of(language) ?? language}
                    </option>
                  )}
                </select>
              </label>
              <OcrPageRange
                value={pageRange}
                onChange={(value) => {
                  setPageRange(value)
                  setResults({})
                  setError(null)
                }}
                disabled={busy}
                lang={lang}
              />
            </>
          )}
          <label className="projects-field">
            <span className="projects-field-label">{fileConversionText(lang, 'outputFormat')}</span>
            <select
              className="translate-select"
              value={target}
              disabled={busy || !targets.length}
              data-testid={`${prefix}-target`}
              onChange={(event) => {
                setTarget(event.target.value)
                setResults({})
                setError(null)
              }}
            >
              {targets.length ? (
                targets.map((format) => (
                  <option key={format} value={format}>
                    {ocr
                      ? fileConversionText(lang, format === 'pdf' ? 'ocrPdf' : 'ocrWord')
                      : format.toUpperCase()}
                  </option>
                ))
              ) : (
                <option value="">—</option>
              )}
            </select>
          </label>
          <button
            type="button"
            className="projects-primary"
            disabled={busy || !target || !pending.length}
            onClick={convert}
            data-testid={`${prefix}-run`}
          >
            {fileConversionText(
              lang,
              activity === 'run'
                ? ocr
                  ? 'ocrRunning'
                  : 'converting'
                : ocr
                  ? 'ocrBatch'
                  : 'convert',
            )}
          </button>
        </div>
      </section>
    </main>
  )
}
