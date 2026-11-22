import { memo, useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { AiComposer, AiTypingIndicator, Markdown } from '@genoffice/ui'
import sendEnterOn from '../assets/send-enter-on.png'
import sendEnterOff from '../assets/send-enter-off.png'
import type { TranslateApi } from '../../../shared/translate-api'
import type { ProjectBatchItem, ProjectBatchSnapshot } from '../../../shared/project-batch'
import { useI18n } from '../locale'
import { makeText, translateErrorText } from './shared'
import { batchChatTargets } from './batch-chat-targets'

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
  verified,
  reviewSamples,
  layoutReview,
  openPair,
  output,
  error,
  rerun,
  rerunDisabled,
}: ProjectBatchItem & {
  openPair?: (file: string, layoutIndex?: number) => Promise<void>
  rerun: (file: string) => void
  rerunDisabled: boolean
}) {
  const { lang, t } = useI18n()
  const s = makeText(lang)
  const [openError, setOpenError] = useState('')
  const [opening, setOpening] = useState(false)
  const label = s(state === 'running' && phase ? phaseLabel[phase] : stateLabel[state])
  const known = done !== undefined && total !== undefined
  const confirmed = state === 'saved' && verified === true && known && done === total
  const open = async (layoutIndex?: number) => {
    if (!openPair || opening) return
    setOpening(true)
    setOpenError('')
    try {
      await openPair(file, layoutIndex)
    } catch (cause) {
      setOpenError(translateErrorText(lang, cause))
    } finally {
      setOpening(false)
    }
  }
  return (
    <li data-batch-file={file} data-batch-state={state}>
      <div className="translate-batch-file">
        <strong dir="auto">{file}</strong>
        <span>{label}</span>
        {(state === 'saved' || state === 'failed') && openPair && output && (
          <button
            type="button"
            className="btn btn-secondary batch-open-pair"
            data-testid="project-batch-open-result"
            title={s('batchOpenPair')}
            aria-label={s('batchOpenPair') + ' · ' + file}
            disabled={opening}
            onClick={() => void open()}
          >
            {t('open')}
          </button>
        )}
        {state !== 'waiting' && state !== 'running' && (
          <button
            type="button"
            className="projects-ghost batch-rerun-file"
            disabled={rerunDisabled}
            title={s('batchRerunFile', { file })}
            aria-label={s('batchRerunFile', { file })}
            data-testid="project-batch-rerun-file"
            onClick={() => rerun(file)}
          >
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 10a9 9 0 1 1 2 8M3 4v6h6" />
            </svg>
          </button>
        )}
      </div>
      {state === 'running' && (
        <progress
          aria-label={file}
          value={known && total > 0 ? done : undefined}
          max={known && total > 0 ? total : 1}
        />
      )}
      {state !== 'waiting' && known && (
        <small data-batch-coverage={confirmed ? 'verified' : 'reported'}>
          {confirmed && total === 0 ? (
            s('batchNoRemaining')
          ) : (
            <>
              {s(phase === 'ocr' ? 'batchOcrCount' : 'batchReportedCount', { done, total })}
              {confirmed && ' · ' + s('batchVerifiedCount')}
            </>
          )}
        </small>
      )}
      {state === 'running' && phase === 'translating' && !known && (
        <small>{s('batchUnknownCount')}</small>
      )}
      {state === 'saved' && !confirmed && !reviewSamples?.length && (
        <small data-batch-coverage="unverified">{s('batchUnverified')}</small>
      )}
      {openError && (
        <small role="alert" className="is-warning">
          {openError}
        </small>
      )}
      {operations !== undefined && operations > 0 && (
        <small data-batch-operations={operations}>{s('batchOperations', { n: operations })}</small>
      )}
      {output && layoutReview === null && (
        <small data-batch-layout="unchecked">{s('batchLayoutUnchecked')}</small>
      )}
      {output && layoutReview && layoutReview.count > 0 && (
        <details data-batch-layout="review">
          <summary>{s('batchLayoutReviewCount', { n: layoutReview.count })}</summary>
          <ul>
            {layoutReview.samples.map(({ location, text, target }, i) => (
              <li key={i}>
                {target && openPair && (state === 'saved' || state === 'failed') ? (
                  <button
                    type="button"
                    className="projects-ghost"
                    data-testid="project-batch-open-layout"
                    disabled={opening}
                    onClick={() => void open(i)}
                  >
                    {location}
                  </button>
                ) : (
                  <code>{location}</code>
                )}
                {text && (
                  <>
                    {' '}
                    · <span dir="auto">{text}</span>
                  </>
                )}
              </li>
            ))}
          </ul>
          {layoutReview.count > layoutReview.samples.length && (
            <small>… (+{layoutReview.count - layoutReview.samples.length})</small>
          )}
        </details>
      )}
      {reviewSamples && reviewSamples.length > 0 && (
        <details>
          <summary>{s('batchReview', { n: known ? total - done : reviewSamples.length })}</summary>
          <ul>
            {reviewSamples.map((sample, i) => (
              <li key={i}>
                <code>{sample.location}</code> · <span dir="auto">{sample.text}</span>
              </li>
            ))}
          </ul>
        </details>
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

const messageStateLabel = {
  queued: 'batchWaiting',
  running: 'batchRunning',
  done: 'batchChatDone',
  failed: 'batchFailed',
  stopped: 'batchStopped',
} as const

function BatchConversation({
  openPair,
  state,
  send,
  wikiAvailable,
  rerun,
  pending,
  availableFiles,
}: {
  openPair?: (file: string, layoutIndex?: number) => Promise<void>
  rerun: (file: string) => void
  pending: boolean
  availableFiles: ReadonlySet<string>
  state: ProjectBatchSnapshot
  wikiAvailable: boolean
  send: (prompt: string, targets: string[], useWiki: boolean) => Promise<void>
}) {
  const { lang, t } = useI18n()
  const s = makeText(lang)
  const label = useId()
  const sending = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState('')
  const [choices, setChoices] = useState<string[] | null>(null)
  const current =
    state.items.find((item) => item.state === 'running')?.file ??
    state.messages
      ?.find((message) => message.targets.some((target) => target.state === 'running'))
      ?.targets.find((target) => target.state === 'running')?.file
  const files = state.items.map((item) => item.file)
  const canSend = Boolean(state.id && !state.stopping && !busy && draft.trim())
  const thread = useRef<HTMLDivElement>(null)
  const last = state.messages?.at(-1)
  const lastStates = last?.targets.map((target) => target.state).join(',')
  const follow = useRef(true)
  useEffect(() => {
    if (thread.current && follow.current) thread.current.scrollTop = thread.current.scrollHeight
  }, [last?.id, last?.reply, last?.partialReply, lastStates])
  async function submit(targets?: string[]) {
    if (!canSend || sending.current) return
    const resolved =
      targets ??
      batchChatTargets(
        draft,
        files,
        current,
        state.messages?.at(-1)?.targets.map((target) => target.file),
        { all: s('batchChatAll'), current: s('batchChatCurrent') },
      )
    if (!resolved?.length) {
      setChoices([])
      return
    }
    sending.current = true
    setBusy(true)
    setError('')
    try {
      // The project agent receives the user's exact words, including whitespace.
      await send(draft, resolved, wikiAvailable)
      setDraft((current) => (current === draft ? '' : current))
      setChoices(null)
    } catch (cause) {
      setError(translateErrorText(lang, cause))
    } finally {
      sending.current = false
      setBusy(false)
    }
  }
  return (
    <>
      <section className="batch-progress-files" aria-label={s('batchOverall')}>
        <BatchTotals state={state} />
        <ul className="translate-batch-list translate-batch-documents">
          {state.items.map((item) => (
            <DocumentProgress
              key={item.file}
              {...item}
              openPair={openPair}
              rerun={rerun}
              rerunDisabled={
                !state.id || pending || state.running || !availableFiles.has(item.file)
              }
            />
          ))}
        </ul>
      </section>
      {state.id && (
        <section className="kb-ask batch-chat" aria-labelledby={label}>
          <h4 id={label}>{s('batchChat')}</h4>
          <div
            ref={thread}
            className="kb-ask-thread batch-chat-history"
            role="log"
            aria-label={s('batchChat')}
            data-testid="project-batch-chat-history"
            onScroll={(event) => {
              const el = event.currentTarget
              follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
            }}
          >
            {state.messages?.map((message) => {
              const inFlight = message.targets.some(
                (t) => t.state === 'queued' || t.state === 'running',
              )
              const failures = [
                ...new Set(
                  message.targets
                    .filter((target) => target.state === 'failed')
                    .map((target) => target.error || s('batchFailed')),
                ),
              ]
              const answer =
                message.reply ??
                (inFlight ? message.partialReply : undefined) ??
                (!inFlight
                  ? message.targets
                      .map((t) => t.reply)
                      .filter(Boolean)
                      .join('\n\n')
                  : '')
              return (
                <article key={message.id}>
                  <div dir="auto" className="kb-ask-msg kb-ask-user">
                    {message.prompt}
                  </div>
                  {answer ? (
                    <div dir="auto" className="kb-ask-msg kb-ask-assistant">
                      <Markdown text={answer} />
                    </div>
                  ) : (
                    inFlight && <AiTypingIndicator label={t('askHintBusy')} />
                  )}
                  {failures.map((failure) => (
                    <p key={failure} role="alert" className="is-warning" dir="auto">
                      {failure}
                    </p>
                  ))}
                  {message.targets.length > 0 && (
                    <details className="batch-chat-targets">
                      <summary>
                        {s('batchProgress')} · {message.targets.length}
                      </summary>
                      {message.targets.map((target) => (
                        <div key={target.file}>
                          <strong dir="auto">{target.file}</strong> ·{' '}
                          {s(messageStateLabel[target.state])}
                        </div>
                      ))}
                    </details>
                  )}
                </article>
              )
            })}
          </div>
          {choices !== null && (
            <fieldset data-testid="project-batch-chat-choose" className="batch-chat-scope">
              <legend>{s('batchChatWhich')}</legend>
              <label>
                <input
                  type="checkbox"
                  checked={choices.length === files.length}
                  onChange={(e) => setChoices(e.target.checked ? files : [])}
                />
                {s('batchChatAll')}
              </label>
              {files.map((file) => (
                <label key={file}>
                  <input
                    type="checkbox"
                    checked={choices.includes(file)}
                    onChange={(e) =>
                      setChoices(
                        e.target.checked
                          ? [...choices, file]
                          : choices.filter((name) => name !== file),
                      )
                    }
                  />
                  <span dir="auto">{file}</span>
                  {file === current && <small>{s('batchChatCurrent')}</small>}
                </label>
              ))}
            </fieldset>
          )}

          {error && (
            <p role="alert" className="is-warning">
              {error}
            </p>
          )}
          <AiComposer
            value={draft}
            busy={false}
            sendDisabled={!canSend || choices?.length === 0}
            placeholder={s('batchChat')}
            ariaLabel={s('batchChat')}
            hintIdle={t('askHintIdle')}
            hintBusy={t('askHintBusy')}
            sendLabel={t('askSend')}
            stopLabel={t('askStop')}
            iconOnly
            sendIconEnabled={<img src={sendEnterOn} alt="" aria-hidden />}
            sendIconDisabled={<img src={sendEnterOff} alt="" aria-hidden />}
            onChange={(value) => {
              setDraft(value)
              setChoices(null)
              setError('')
            }}
            onSend={() => void submit(choices ?? undefined)}
            onStop={() => {}}
          />
        </section>
      )}
    </>
  )
}

export function ProjectBatchControl({
  api,
  dir,
  files,
  primary,
  wikiAvailable,
}: {
  wikiAvailable: boolean
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
  const batchId = state?.id
  const openPair = useCallback(
    async (file: string, layoutIndex?: number) => {
      if (batchId)
        await api.batchOpenResult({
          dir,
          batchId,
          file,
          ...(layoutIndex === undefined ? {} : { layoutIndex }),
        })
    },
    [api, dir, batchId],
  )
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

  const act = useCallback(
    async (mode: 'start' | 'retry' | 'rerun' | 'stop', selected?: string[]) => {
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
            ...(mode === 'rerun' && { rerunBatchId: batchId }),
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
    },
    [api, batchId, dir, lang, pending],
  )
  const rerunFile = useCallback((file: string) => void act('rerun', [file]), [act])
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
          <div className="translate-batch-progress-body">
            <BatchConversation
              key={dir}
              openPair={batchId ? openPair : undefined}
              availableFiles={listed}
              pending={pending}
              rerun={rerunFile}
              wikiAvailable={wikiAvailable}
              state={state}
              send={async (prompt, files, useWiki) => {
                if (!state.id) return
                const before = events.current
                const next = await api.batchSend({ dir, batchId: state.id, prompt, files, useWiki })
                if (before === events.current) setState(next)
              }}
            />
          </div>
          {error && (
            <p role="alert" className="projects-note is-warning">
              {error}
            </p>
          )}
          <div className="modal-buttons batch-progress-actions">
            <button
              type="button"
              className="btn btn-secondary batch-rerun-all"
              data-testid="project-batch-rerun-all"
              disabled={
                pending ||
                state.running ||
                !state.id ||
                !state.items.length ||
                state.items.some((item) => !listed.has(item.file))
              }
              onClick={() =>
                void act(
                  'rerun',
                  state.items.map((item) => item.file),
                )
              }
            >
              {s('batchRerunAll')}
            </button>
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
  return (
    <div className="translate-batch-totals">
      <div>
        <strong>{s('batchOverall')}</strong>
        <span>{s('batchSavedCount', { done: saved, total: state.items.length })}</span>
      </div>
      <progress aria-label={s('batchOverall')} value={saved} max={state.items.length || 1} />
      {(failed > 0 || stopped > 0) && (
        <p role="status">
          {[failed && s('batchFailed') + ' ' + failed, stopped && s('batchStopped') + ' ' + stopped]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
    </div>
  )
}
