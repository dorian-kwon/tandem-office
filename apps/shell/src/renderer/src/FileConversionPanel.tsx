import { useState } from 'react'
import type { FileConversionInput, FileConversionResult } from '../../shared/file-conversion'
import { translateText } from './i18n/strings-translate'
import { fileConversionText } from './i18n/strings-file-conversion'
import { useI18n } from './locale'
import './file-conversion.css'

function commonTargets(files: FileConversionInput[]): string[] {
  return (
    files[0]?.targets.filter((format) => files.every((file) => file.targets.includes(format))) ?? []
  )
}

export function FileConversionPanel({ visible }: { visible: boolean }) {
  const { lang } = useI18n()
  const [files, setFiles] = useState<FileConversionInput[]>([])
  const [target, setTarget] = useState('')
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

  async function pickFiles() {
    const api = window.fileConversionApi
    if (!api || busy) return
    setActivity('pick')
    setError(null)
    try {
      const picked = await api.pick()
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
    const api = window.fileConversionApi
    if (!api || busy || !target || !pending.length) return
    const ids = pending.map((file) => file.id)
    setActivity('run')
    setError(null)
    const unsubscribe = api.onProgress((result) => {
      setResults((previous) => ({ ...previous, [result.id]: result }))
    })
    try {
      const completed = await api.run(ids, target)
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
    <main className="content" data-testid="file-conversion-panel">
      <section className="file-conversion-pane" aria-labelledby="file-conversion-title">
        <header className="translate-head">
          <div className="translate-head-text">
            <h2 id="file-conversion-title" className="translate-title">
              {fileConversionText(lang, 'title')}
            </h2>
            <p className="translate-lede">{fileConversionText(lang, 'destinationHint')}</p>
          </div>
        </header>
        <div className="projects-toolbar">
          <button
            type="button"
            className="projects-ghost"
            disabled={busy}
            onClick={pickFiles}
            data-testid="file-conversion-pick"
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
                <li key={file.id} className="projects-row" data-testid="file-conversion-file">
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
                          : [fileConversionText(lang, 'failed'), result.error]
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
          <label className="projects-field">
            <span className="projects-field-label">{fileConversionText(lang, 'outputFormat')}</span>
            <select
              className="translate-select"
              value={target}
              disabled={busy || !targets.length}
              data-testid="file-conversion-target"
              onChange={(event) => {
                setTarget(event.target.value)
                setResults({})
                setError(null)
              }}
            >
              {targets.length ? (
                targets.map((format) => (
                  <option key={format} value={format}>
                    {format.toUpperCase()}
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
            data-testid="file-conversion-run"
          >
            {fileConversionText(lang, activity === 'run' ? 'converting' : 'convert')}
          </button>
        </div>
      </section>
    </main>
  )
}
