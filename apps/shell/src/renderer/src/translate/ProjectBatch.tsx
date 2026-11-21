import { memo, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { TranslateApi } from '../../../shared/translate-api'
import type { ProjectBatchItem, ProjectBatchSnapshot } from '../../../shared/project-batch'
import { useI18n } from '../locale'
import { makeText, translateErrorText } from './shared'

type BatchView = 'select' | 'progress' | null

function BatchDialog({
  view,
  title,
  children,
  close,
}: {
  view: Exclude<BatchView, null>
  title: string
  children: ReactNode
  close: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const node = ref.current
    node?.showModal()
    return () => node?.close()
  }, [])
  return (
    <dialog
      ref={ref}
      className="modal translate-batch-dialog"
      aria-labelledby={titleId}
      data-testid={'project-batch-' + view}
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
    >
      <h3 id={titleId}>{title}</h3>
      {children}
    </dialog>
  )
}

function BatchSelection({
  files,
  start,
  close,
  pending,
  error,
}: {
  files: string[]
  start: (files: string[]) => void
  close: () => void
  pending: boolean
  error: string
}) {
  const { lang } = useI18n()
  const s = makeText(lang)
  const [selected, setSelected] = useState(() => new Set(files))
  const allCheck = useRef<HTMLInputElement>(null)
  const chosen = files.filter((file) => selected.has(file))
  const all = files.length > 0 && chosen.length === files.length
  useEffect(() => {
    if (allCheck.current) allCheck.current.indeterminate = !all && chosen.length > 0
  }, [all, chosen.length])
  return (
    <BatchDialog view="select" title={s('batchSelectTitle')} close={close}>
      <div className="translate-batch-selection-heading">
        <label>
          <input
            ref={allCheck}
            type="checkbox"
            checked={all}
            disabled={pending || !files.length}
            onChange={() => setSelected(new Set(all ? [] : files))}
          />
          {s('ocrSelectAll')}
        </label>
        <span>{s('ocrSelectedCount', { count: chosen.length, total: files.length })}</span>
      </div>
      <ul className="translate-batch-list">
        {files.map((file) => (
          <li key={file}>
            <label>
              <input
                type="checkbox"
                checked={selected.has(file)}
                disabled={pending}
                onChange={(event) => {
                  const checked = event.currentTarget.checked
                  setSelected((previous) => {
                    const next = new Set(previous)
                    if (checked) next.add(file)
                    else next.delete(file)
                    return next
                  })
                }}
              />
              <span dir="auto">{file}</span>
            </label>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="projects-note is-warning">
          {error}
        </p>
      )}
      <div className="modal-buttons">
        <button type="button" className="btn btn-secondary" onClick={close}>
          {s('cancel')}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          data-testid="project-batch-submit"
          disabled={pending || !chosen.length}
          onClick={() => start(chosen)}
        >
          {s('batchTranslateSelected')}
        </button>
      </div>
    </BatchDialog>
  )
}

const stateLabel = {
  waiting: 'batchWaiting',
  running: 'batchRunning',
  saved: 'saved',
  failed: 'batchFailed',
  stopped: 'batchStopped',
} as const
const phaseLabel = {
  opening: 'batchOpening',
  ocr: 'batchOcr',
  translating: 'batchRunning',
  saving: 'batchSaving',
} as const

const DocumentProgress = memo(function DocumentProgress({
  file,
  state,
  done,
  total,
  phase,
  operations,
  output,
  error,
}: ProjectBatchItem) {
  const { lang } = useI18n()
  const s = makeText(lang)
  const label = s(state === 'running' && phase ? phaseLabel[phase] : stateLabel[state])
  const known = total !== undefined && total > 0
  return (
    <li data-batch-file={file} data-batch-state={state}>
      <div className="translate-batch-file">
        <strong dir="auto">{file}</strong>
        <span>{label}</span>
      </div>
      {state === 'saved' || state === 'waiting' || state === 'running' || known ? (
        <progress
          aria-label={file}
          value={state === 'saved' ? 1 : state === 'waiting' ? 0 : known ? (done ?? 0) : undefined}
          max={state === 'saved' || !known ? 1 : total}
        />
      ) : null}
      {known && state !== 'waiting' && (
        <small>
          {done ?? 0} / {total}
        </small>
      )}
      {operations !== undefined && operations > 0 && (
        <small data-batch-operations={operations}>{s('batchOperations', { n: operations })}</small>
      )}
      {output && output !== file && <small dir="auto">{output}</small>}
      {error && (
        <small className="is-warning" dir="auto">
          {error}
        </small>
      )}
    </li>
  )
})

export function ProjectBatchControl({
  api,
  dir,
  files,
  primary,
}: {
  dir: string
  files: string[]
  primary: boolean
  api: TranslateApi
}) {
  const { lang } = useI18n()
  const s = makeText(lang)
  const [state, setState] = useState<ProjectBatchSnapshot | null>(null)
  const [view, setView] = useState<BatchView>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  // Keep a dismissed dialog closed during progress ticks. A newly started batch,
  // including one requested in chat, gets its own progress dialog.
  const wasRunning = useRef(false)
  const events = useRef(0)
  useEffect(() => {
    let current = true
    let sawEvent = false
    function receive(snapshot: ProjectBatchSnapshot | null) {
      if (!current || !snapshot || snapshot.dir !== dir) return
      if (snapshot.running && !wasRunning.current) {
        setError('')
        setView('progress')
      }
      wasRunning.current = snapshot.running
      setState(snapshot)
    }
    const off = api.onBatchChanged((snapshot) => {
      if (snapshot.dir !== dir) return
      sawEvent = true
      events.current++
      receive(snapshot)
    })
    void api.batchStatus(dir).then(
      (snapshot) => {
        if (!sawEvent) receive(snapshot)
      },
      () => undefined,
    )
    return () => {
      current = false
      off()
    }
  }, [api, dir])

  const act = async (mode: 'start' | 'retry' | 'stop', selected?: string[]) => {
    if (pending) return
    const before = events.current
    setPending(true)
    setError('')
    try {
      if (mode === 'stop') await api.batchStop(dir)
      else {
        const snapshot = await api.batchStart({
          dir,
          files: selected,
          ...(mode === 'retry' && { retry: true }),
        })
        // Progress can be delivered before the start acknowledgement.
        if (before === events.current) {
          wasRunning.current = snapshot.running
          setState(snapshot)
          setView('progress')
        }
      }
    } catch (cause) {
      setError(translateErrorText(lang, cause))
    } finally {
      setPending(false)
    }
  }
  const close = () => setView(null)
  const listed = new Set(files)
  const actionable = (status: 'failed' | 'stopped') =>
    !state || state.running
      ? []
      : state.items
          .filter((item) => item.state === status && listed.has(item.file))
          .map((item) => item.file)
  const failed = actionable('failed')
  const stopped = actionable('stopped')
  return (
    <>
      <button
        type="button"
        className={primary ? 'projects-primary' : 'projects-ghost'}
        data-testid="project-batch-start"
        disabled={pending || state?.running || !files.length}
        onClick={() => {
          setError('')
          setView('select')
        }}
      >
        {s('batchTranslate')}
      </button>
      {state && (
        <button
          type="button"
          className="projects-ghost"
          data-testid="project-batch-show-progress"
          onClick={() => setView('progress')}
        >
          {s('batchProgress')}
        </button>
      )}
      {view === 'select' && (
        <BatchSelection
          files={files}
          start={(chosen) => void act('start', chosen)}
          close={close}
          pending={pending}
          error={error}
        />
      )}
      {view === 'progress' && state && (
        <BatchDialog view="progress" title={s('batchProgress')} close={close}>
          <BatchTotals state={state} />
          <ul className="translate-batch-list translate-batch-documents">
            {state.items.map((item) => (
              <DocumentProgress key={item.file} {...item} />
            ))}
          </ul>
          {error && (
            <p role="alert" className="projects-note is-warning">
              {error}
            </p>
          )}
          <div className="modal-buttons">
            {state.running && (
              <button
                type="button"
                className="btn btn-secondary"
                data-testid="project-batch-stop"
                disabled={pending || state.stopping}
                onClick={() => void act('stop')}
              >
                {s('trStop')}
              </button>
            )}
            {!state.running && failed.length > 0 && (
              <button
                type="button"
                className="btn btn-primary"
                data-testid="project-batch-retry"
                disabled={pending}
                onClick={() => void act('retry', failed)}
              >
                {s('batchRetry')}
              </button>
            )}
            {stopped.length > 0 && (
              <button
                type="button"
                className="btn btn-secondary"
                data-testid="project-batch-resume"
                disabled={pending}
                onClick={() => void act('retry', stopped)}
              >
                {s('batchResume')}
              </button>
            )}
            <button
              type="button"
              className="btn btn-secondary"
              data-testid="project-batch-close"
              onClick={close}
            >
              {s('ocrClose')}
            </button>
          </div>
        </BatchDialog>
      )}
    </>
  )
}

function BatchTotals({ state }: { state: ProjectBatchSnapshot }) {
  const { lang } = useI18n()
  const s = makeText(lang)
  const saved = state.items.filter((item) => item.state === 'saved').length
  const failed = state.items.filter((item) => item.state === 'failed').length
  const stopped = state.items.filter((item) => item.state === 'stopped').length
  const processed = saved + failed
  const current = state.items.find((item) => item.state === 'running')
  // OCR precedes document translation. Its page count belongs to the file row.
  const units =
    current?.phase !== 'ocr' && current?.total
      ? Math.min(1, (current.done ?? 0) / current.total)
      : 0
  const overall = processed + units
  // The editor may have translated the last unit while a save is pending.
  const awaitingSave = state.running && overall >= state.items.length
  return (
    <div className="translate-batch-totals">
      <div>
        <strong>{s('batchOverall')}</strong>
        <span>
          {processed} / {state.items.length}
        </span>
      </div>
      <progress
        aria-label={s('batchOverall')}
        value={awaitingSave ? undefined : overall}
        max={state.items.length || 1}
      />
      <p role="status">
        {s('saved')} {saved} · {s('batchFailed')} {failed}
        {stopped > 0 && ' · ' + s('batchStopped') + ' ' + stopped}
      </p>
    </div>
  )
}
