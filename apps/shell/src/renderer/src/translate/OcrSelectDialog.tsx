import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { AiSettings } from '@genoffice/ai-provider/browser'
import type { SourceEntry } from '@genoffice/translate-project'
import { AiConnectPrompt, aiProviderDisplayName } from '@genoffice/ui'
import { aiReadVisionCheck } from '../../../../../../packages/pdf-structure/src/ai-read/vision'
import type { TranslateApi } from '../../../shared/translate-api'
import {
  OcrCancelledError,
  runOcr,
  type OcrAsk,
  type OcrBridge,
  type OcrPrepared,
  type OcrProgress,
  type OcrPageResult,
  type OcrPlacement,
  type OcrRecommendation,
  type OcrSettled,
  type RunOcrResult,
} from '../../../shared/translate-ocr'
import { useI18n } from '../locale'
import type { SubscriptionConnection } from '../subscription-client'
import { createOcrAsk } from './ocr-ask'
import { ocrRoute, type OcrRoute } from './ocr-route'
import { makeText, translateErrorText } from './shared'
import { OcrImagePreview } from './OcrImagePreview'
import { OcrImageLightbox } from './OcrImageLightbox'
import { OcrPlacementDialog } from './OcrPlacementDialog'
import {
  ocrPayloadPlainText,
  type OcrPopupResult,
  type OcrPopupUnread,
} from '../../../shared/ocr-popup'

/**
 * The translation OCR window (spec 6.5): pick the pages of a scanned PDF or
 * the image files to read. First choose all items or open the selection
 * list, then confirm the count and transfer before running. The selection
 * list starts empty, and Next stays disabled while nothing is chosen.
 *
 * The confirmation shows how many items go out, to which AI (the project's
 * OCR choice, through the app's own connection and send gate, `ocrRoute`),
 * that the page images are sent, and "<provider> will charge for this" on an
 * accepted metered login. Start is the only thing that sends: it is enabled
 * only when that AI can run now and reads images. Back and Cancel send
 * nothing. The first-connection notice is the home screen's dialog
 * (`onNoticeNeeded`), as for the other home panels.
 *
 * The run itself is `runOcr`; embedded sources keep their format and require placement review.
 */

/** pictures of one document: embedded in a docx or xlsx, or taken out of a Hangul document */
function hasPictureKind(prepared: OcrPrepared | null | undefined): prepared is OcrPrepared {
  return prepared?.kind === 'embedded' || prepared?.kind === 'extracted'
}

export interface OcrSelectDialogProps {
  /** a registered translation project */
  dir: string
  /** One PDF or DOCX/XLSX source, or standalone images in reading order. */
  sources: SourceEntry[]
  /** the AI settings as last read; null until they are */
  aiSettings: AiSettings | null
  /** the live subscription connection (the home screen's one instance) */
  connection: SubscriptionConnection
  /** the confirmation needs the first-connection notice: the home screen shows it */
  onNoticeNeeded?: () => void
  /** open Settings at the AI section (the connect prompt's settings button) */
  onOpenAiSettings: () => void
  /** the run ended with a document */
  onFinished?: (result: RunOcrResult) => void
  /** open the written document (shown as a button when given) */
  onOpenResult?: (outputPath: string) => void
  /**
   * Picking only: after the confirmed start and the reading, hand the recognised text to
   * `onRecognised` and stop. Nothing is placed or written here; where the text goes is
   * decided with the person in the AI chat that asked for this popup.
   */
  selectOnly?: boolean
  onRecognised?: (result: OcrPopupResult) => void
  onClose: () => void
  /** the bridge; default window.translateApi (tests pass a fake) */
  api?: TranslateApi
  /** the model call for a confirmed route; default the shared ai:stream call */
  makeAsk?: (confirmed: Extract<OcrRoute, { state: 'ready' }>, current: () => OcrRoute) => OcrAsk
}

type Step =
  | { kind: 'loading' }
  | { kind: 'scope' }
  | { kind: 'pick' }
  | { kind: 'confirm'; count: number }
  | { kind: 'running'; progress: OcrProgress }
  | {
      kind: 'place'
      pages: OcrPageResult[]
      busy: boolean
      error?: unknown
      recommendation?: OcrRecommendation
    }
  | { kind: 'done'; result: RunOcrResult }
  | { kind: 'review'; problems: OcrProblem[] }
  | { kind: 'error'; text: string }

/** a picture that gave no text in the picking popup: nothing found, or it could not be read */
export interface OcrProblem {
  index: number
  kind: 'empty' | 'malformed' | 'error' | 'stopped'
  message: string
}

function ocrBridge(api: TranslateApi): OcrBridge {
  return {
    prepare: (dir, files) => api.ocrPrepare({ dir, files }),
    start: (token, pages) => api.ocrStart({ token, pages }),
    pageImage: (token, index) => api.ocrPageImage({ token, index }),
    write: (token, pages, placement) =>
      api.ocrWrite({ token, pages, ...(placement ? { placement } : {}) }),
    release: (token) => api.ocrRelease(token),
  }
}

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path

export function OcrSelectDialog(props: OcrSelectDialogProps): ReactElement {
  const { lang } = useI18n()
  const s = makeText(lang)
  const api = props.api ?? window.translateApi
  const [step, setStep] = useState<Step>({ kind: 'loading' })
  const [prepared, setPrepared] = useState<OcrPrepared | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const propsRef = useRef(props)
  propsRef.current = props
  /** answers the pending confirmation (runOcr's `confirm`) */
  const answerRef = useRef<((go: boolean) => void) | null>(null)
  const placementRef = useRef<((placement: OcrPlacement | null) => void) | null>(null)
  /** Back was pressed: the cancelled run returns to the picker */
  const backRef = useRef(false)
  const backStepRef = useRef<'scope' | 'pick' | 'review'>('pick')
  const askRef = useRef<OcrAsk | null>(null)
  const runRef = useRef<AbortController | null>(null)
  const tokenRef = useRef<string | null>(null)
  /** selectOnly: the readings were handed over, so the run's own stop is not an error */
  const recognisedRef = useRef(false)
  /** selectOnly: what the last run reported for each picture (read, or failed with a reason) */
  const outcomeRef = useRef<OcrSettled | null>(null)
  /** selectOnly: text kept per picture across runs, so a retry of the failed ones adds to it */
  const collectedRef = useRef(new Map<number, string>())
  /** selectOnly: every picture the person asked for, over all runs */
  const requestedRef = useRef(new Set<number>())
  /** selectOnly: the review is showing, so the run's own stop is not an error */
  const reviewRef = useRef<OcrProblem[] | null>(null)
  /** the review was shown by the run now ending */
  const reviewShownRef = useRef(false)
  /** Stop was pressed during the run */
  const stopRef = useRef(false)
  /** the picture shown enlarged (1-based number), or null */
  const [lightbox, setLightbox] = useState<number | null>(null)

  const route =
    prepared?.ocr.kind === 'ai'
      ? ocrRoute(prepared.ocr.provider, props.aiSettings, props.connection.statuses)
      : null
  const routeRef = useRef(route)
  routeRef.current = route

  // list the pages or files once; the token is released when the window goes
  useEffect(() => {
    let alive = true
    if (!api) {
      setStep({
        kind: 'error',
        text: translateErrorText(lang, new Error('[OCR_FAILED] no bridge')),
      })
      return
    }
    api.ocrPrepare({ dir: props.dir, files: props.sources.map((src) => src.file) }).then(
      (out) => {
        if (!alive) {
          void api.ocrRelease(out.token).catch(() => undefined)
          return
        }
        tokenRef.current = out.token
        setPrepared(out)
        setStep({ kind: 'scope' })
      },
      (err: unknown) => {
        if (alive) setStep({ kind: 'error', text: translateErrorText(lang, err) })
      },
    )
    return () => {
      alive = false
      answerRef.current?.(false)
      placementRef.current?.(null)
      runRef.current?.abort()
      if (tokenRef.current) void api.ocrRelease(tokenRef.current).catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opened window
  }, [])

  // the confirmation needs the first-connection notice: ask the home screen for it
  const noticeAsked = useRef(false)
  useEffect(() => {
    if (step.kind === 'confirm' && route?.state === 'notice' && !noticeAsked.current) {
      noticeAsked.current = true
      propsRef.current.onNoticeNeeded?.()
    }
  }, [step.kind, route?.state])

  const items = prepared?.items ?? []
  const toggle = (index: number) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })

  /** the picture's text for the asking chat, with the local placement analysis for these pictures */
  const deliver = async (
    indices: number[],
    token: string,
    unread: OcrPopupUnread[],
  ): Promise<void> => {
    if (!api) return
    const recommendation =
      typeof api.ocrRecommend === 'function' && indices.length > 0
        ? await api.ocrRecommend({ token, pages: indices }).catch(() => undefined)
        : undefined
    recognisedRef.current = true
    propsRef.current.onRecognised?.({
      pages: indices.map((index) => ({
        index,
        location: items[index - 1]?.location ?? '',
        text: collectedRef.current.get(index) ?? '',
      })),
      ...(unread.length > 0 ? { unread } : {}),
      ...(recommendation ? { recommendation } : {}),
    })
  }

  const problemsFrom = (outcome: OcrSettled | null, empties: number[]): OcrProblem[] =>
    [
      ...(outcome?.failures ?? []).map((f): OcrProblem => ({
        index: f.index,
        kind: f.reason,
        message: f.message,
      })),
      ...empties.map((index): OcrProblem => ({ index, kind: 'empty', message: '' })),
    ].sort((a, b) => a.index - b.index)

  const showReview = (problems: OcrProblem[]) => {
    reviewShownRef.current = true
    reviewRef.current = problems
    setStep({ kind: 'review', problems })
  }

  /** go on with what was read; the pictures without text are named for the chat */
  const acceptRead = async (problems: OcrProblem[]) => {
    if (!api || !prepared) return
    const indices = [...collectedRef.current.keys()].sort((a, b) => a - b)
    if (indices.length === 0) return
    const unread: OcrPopupUnread[] = problems.map((p) => ({
      index: p.index,
      location: items[p.index - 1]?.location ?? '',
      reason: p.kind === 'empty' ? 'empty' : 'failed',
    }))
    // the lease of the last run covers only its own pictures: the recommendation needs one
    // that names all of them (selecting is local; no picture is read or sent)
    const old = tokenRef.current
    tokenRef.current = null
    if (old) await api.ocrRelease(old).catch(() => undefined)
    try {
      const fresh = await api.ocrPrepare({
        dir: props.dir,
        files: props.sources.map((x) => x.file),
      })
      tokenRef.current = fresh.token
      await api.ocrStart({ token: fresh.token, pages: indices })
      await deliver(indices, fresh.token, unread)
    } catch {
      recognisedRef.current = true
      propsRef.current.onRecognised?.({
        pages: indices.map((index) => ({
          index,
          location: items[index - 1]?.location ?? '',
          text: collectedRef.current.get(index) ?? '',
        })),
        ...(unread.length > 0 ? { unread } : {}),
      })
    }
  }

  /** read only the pictures that gave no text, after the usual confirmation */
  const retry = async (problems: OcrProblem[]) => {
    if (!api) return
    const old = tokenRef.current
    tokenRef.current = null
    if (old) await api.ocrRelease(old).catch(() => undefined)
    try {
      const fresh = await api.ocrPrepare({
        dir: props.dir,
        files: props.sources.map((x) => x.file),
      })
      tokenRef.current = fresh.token
      setPrepared(fresh)
      reviewRef.current = problems
      next(
        problems.map((p) => p.index),
        fresh,
        'review',
      )
    } catch (err) {
      setStep({ kind: 'error', text: translateErrorText(lang, err) })
    }
  }

  const next = (
    pages: number[] = [...selected],
    preparedNow: OcrPrepared | null = prepared,
    backTo?: 'review',
  ) => {
    if (!api || !preparedNow || pages.length === 0) return
    const prepared = preparedNow
    backRef.current = false
    backStepRef.current = backTo ?? (step.kind === 'scope' ? 'scope' : 'pick')
    outcomeRef.current = null
    reviewShownRef.current = false
    stopRef.current = false
    for (const p of pages) requestedRef.current.add(p)
    const controller = new AbortController()
    runRef.current = controller
    void runOcr({
      dir: props.dir,
      source: props.sources,
      selection: { kind: 'pages', pages },
      prepared,
      onSettled: (outcome) => {
        outcomeRef.current = outcome
      },
      bridge: ocrBridge(api),
      confirm: (count) =>
        new Promise<boolean>((resolve) => {
          answerRef.current = resolve
          setStep({ kind: 'confirm', count })
        }),
      ask: (provider, request, signal) => {
        const ask = askRef.current
        if (!ask) return Promise.reject(new OcrCancelledError('no confirmed AI'))
        return ask(provider, request, signal)
      },
      signal: controller.signal,
      onProgress: (progress) => setStep({ kind: 'running', progress }),
      // the chat popup only wants text; the translation project places boxes over docx pictures
      ...(prepared.kind === 'embedded' && prepared.format === 'docx' && !props.selectOnly
        ? { boxes: true }
        : {}),
      ...(prepared.kind === 'embedded' && props.selectOnly
        ? {
            choosePlacement: async (done: OcrPageResult[]) => {
              // closing the window ends the run without a review; Stop keeps what was read
              if (controller.signal.aborted && !stopRef.current) return null
              // a reading with no text is a result to look at, never a silent success
              const empties: number[] = []
              for (const p of done) {
                const text = ocrPayloadPlainText(p.payload).trim()
                if (text) collectedRef.current.set(p.index, text)
                else {
                  collectedRef.current.delete(p.index)
                  empties.push(p.index)
                }
              }
              const outcome = outcomeRef.current
              const problems = [
                ...problemsFrom(outcome, empties),
                // Stop left some pictures unasked: they can be retried too
                ...(stopRef.current
                  ? pages
                      .filter(
                        (p) =>
                          !done.some((d) => d.index === p) &&
                          !outcome?.failures.some((f) => f.index === p),
                      )
                      .map((index): OcrProblem => ({ index, kind: 'stopped', message: '' }))
                  : []),
              ].sort((a, b) => a.index - b.index)
              if (problems.length > 0) {
                showReview(problems)
                return null
              }
              // no destination here: ending the run releases the lease without writing
              if (collectedRef.current.size === pages.length) {
                await deliver(
                  [...pages].sort((a, b) => a - b),
                  prepared.token,
                  [],
                )
              } else {
                // a retry that completed the set: the analysis needs a lease naming all of it
                await acceptRead([])
              }
              return null
            },
          }
        : prepared.kind === 'embedded'
          ? {
              choosePlacement: async (pages: OcrPageResult[], error?: unknown) => {
                const recommendation =
                  typeof api.ocrRecommend === 'function'
                    ? await api.ocrRecommend({
                        token: prepared.token,
                        pages: pages.map((p) => p.index),
                      })
                    : undefined
                if (controller.signal.aborted) return null
                return new Promise<OcrPlacement | null>((resolve) => {
                  placementRef.current = resolve
                  setStep({
                    kind: 'place',
                    pages,
                    busy: false,
                    ...(error !== undefined ? { error } : {}),
                    ...(recommendation ? { recommendation } : {}),
                  })
                })
              },
            }
          : {}),
    }).then(
      (result) => {
        runRef.current = null
        // the token was used up by the write
        tokenRef.current = null
        setStep({ kind: 'done', result })
        propsRef.current.onFinished?.(result)
      },
      (err: unknown) => {
        runRef.current = null
        if (recognisedRef.current || reviewShownRef.current) return
        if (err instanceof OcrCancelledError && backRef.current) {
          if (backStepRef.current === 'review' && reviewRef.current)
            setStep({ kind: 'review', problems: reviewRef.current })
          else setStep({ kind: backStepRef.current === 'review' ? 'pick' : backStepRef.current })
          return
        }
        // picking only: nothing read, or the person pressed Stop: show what each picture did
        // (with a way to retry) instead of a bare error
        if (props.selectOnly && prepared.kind === 'embedded') {
          const outcome = outcomeRef.current
          const unasked = pages.filter(
            (p) => !collectedRef.current.has(p) && !outcome?.failures.some((f) => f.index === p),
          )
          const problems = [
            ...problemsFrom(outcome, []),
            ...(stopRef.current
              ? unasked.map((index): OcrProblem => ({ index, kind: 'stopped', message: '' }))
              : []),
          ].sort((a, b) => a.index - b.index)
          if (problems.length > 0) {
            showReview(problems)
            return
          }
        }
        setStep({ kind: 'error', text: translateErrorText(lang, err) })
      },
    )
  }

  const answer = (go: boolean) => {
    const resolve = answerRef.current
    answerRef.current = null
    resolve?.(go)
  }

  const start = () => {
    const r = routeRef.current
    if (!r || r.state !== 'ready' || !prepared || prepared.ocr.kind !== 'ai') return
    if (!aiReadVisionCheck(r.provider, r.model).ok) return
    const current = () => routeRef.current ?? { state: 'checking' as const }
    askRef.current = props.makeAsk
      ? props.makeAsk(r, current)
      : createOcrAsk({
          confirmed: r,
          ocr: prepared.ocr.provider,
          current,
          lang: () => lang,
          // pictures inside a document: text in drawings and speech bubbles counts
          pictures: hasPictureKind(prepared),
        })
    setStep({
      kind: 'running',
      progress: { done: 0, total: step.kind === 'confirm' ? step.count : 0, current: null },
    })
    answer(true)
  }

  const back = () => {
    backRef.current = true
    answer(false)
  }

  const close = () => {
    answer(false)
    placementRef.current?.(null)
    placementRef.current = null
    runRef.current?.abort()
    props.onClose()
  }

  const title =
    step.kind === 'place'
      ? s('ocrPlaceTitle')
      : step.kind === 'confirm'
        ? s('ocrConfirmTitle')
        : step.kind === 'review'
          ? s('ocrReviewTitle')
          : s('ocrTitle')

  return (
    <div className="modal-overlay">
      <div
        className="modal translate-ocr"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-step={step.kind}
      >
        <h3>{title}</h3>
        {step.kind === 'loading' && (
          <p role="status" data-loading>
            {s('ocrLoading')}
          </p>
        )}
        {step.kind === 'scope' && (
          <>
            <p>{s('ocrScopePrompt', { count: items.length })}</p>
            <div className="modal-buttons">
              <button type="button" className="btn btn-secondary" onClick={close}>
                {s('cancel')}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={items.length === 0}
                onClick={() => next(items.map((item) => item.index))}
              >
                {s('ocrReadAll')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={items.length === 0}
                onClick={() => {
                  setSelected(new Set())
                  setStep({ kind: 'pick' })
                }}
              >
                {s('ocrChooseItems')}
              </button>
            </div>
          </>
        )}
        {step.kind === 'pick' && (
          <>
            <p>
              {s(
                props.selectOnly
                  ? 'ocrPopupIntro'
                  : prepared?.kind === 'embedded'
                    ? 'ocrPlaceIntro'
                    : 'ocrIntro',
              )}
            </p>
            <div className="translate-ocr-tools">
              <button
                type="button"
                className="btn btn-secondary"
                data-action="select-all"
                onClick={() => setSelected(new Set(items.map((i) => i.index)))}
              >
                {s('ocrSelectAll')}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                data-action="clear"
                onClick={() => setSelected(new Set())}
              >
                {s('ocrClear')}
              </button>
            </div>
            <ul className="translate-ocr-items" data-items>
              {items.map((item) => (
                <li key={item.index} data-item={item.index}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.has(item.index)}
                      onChange={() => toggle(item.index)}
                    />
                    {api && hasPictureKind(prepared) && (
                      <OcrImagePreview
                        api={api}
                        token={prepared.token}
                        index={item.index}
                        name={item.name}
                      />
                    )}
                    <span>
                      {hasPictureKind(prepared) && (
                        <strong className="translate-ocr-number" data-number={item.index}>
                          {s('ocrPictureNumber', { n: item.index })}
                        </strong>
                      )}{' '}
                      {item.name || s('ocrPageLabel', { page: item.index })}
                      {item.page !== undefined && (
                        <small className="translate-ocr-page" data-page={item.page}>
                          {s(item.pageApprox ? 'ocrPageLabelApprox' : 'ocrPageLabel', {
                            page: item.page,
                          })}
                        </small>
                      )}
                      {item.location && (
                        <small className="translate-ocr-location">{item.location}</small>
                      )}
                    </span>
                  </label>
                  {hasPictureKind(prepared) && (
                    <button
                      type="button"
                      className="btn btn-secondary translate-ocr-enlarge"
                      data-action="enlarge"
                      aria-label={s('ocrEnlarge', { n: item.index })}
                      title={s('ocrEnlarge', { n: item.index })}
                      onClick={() => setLightbox(item.index)}
                    >
                      ⌕
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <p className="translate-ocr-count" data-selected-count={selected.size}>
              {s('ocrSelectedCount', { count: selected.size, total: items.length })}
            </p>
            {selected.size === 0 && <p className="projects-hint">{s('ocrNothingSelected')}</p>}
            <div className="modal-buttons">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setStep({ kind: 'scope' })}
              >
                {s('ocrBack')}
              </button>
              <button type="button" className="btn btn-secondary" onClick={close}>
                {s('cancel')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                data-action="next"
                disabled={selected.size === 0}
                onClick={() => next()}
              >
                {s('ocrNext')}
              </button>
            </div>
          </>
        )}
        {step.kind === 'confirm' && (
          <OcrConfirm
            count={step.count}
            route={route}
            connection={props.connection}
            lang={lang}
            onOpenAiSettings={props.onOpenAiSettings}
            onBack={back}
            onCancel={close}
            onStart={start}
          />
        )}
        {step.kind === 'running' && (
          <>
            <p role="status" data-progress={`${step.progress.done}/${step.progress.total}`}>
              {s('ocrRunning', { done: step.progress.done, total: step.progress.total })}
            </p>
            <div className="modal-buttons">
              <button
                type="button"
                className="btn btn-secondary"
                data-action="stop"
                onClick={() => {
                  stopRef.current = true
                  runRef.current?.abort()
                }}
              >
                {s('ocrStop')}
              </button>
            </div>
          </>
        )}
        {step.kind === 'place' && prepared && (
          <OcrPlacementDialog
            prepared={prepared}
            pages={step.pages}
            busy={step.busy}
            error={step.error}
            recommendation={step.recommendation}
            api={api}
            onCancel={close}
            onPlace={(placement) => {
              setStep({ ...step, busy: true })
              const resolve = placementRef.current
              placementRef.current = null
              resolve?.(placement)
            }}
          />
        )}
        {step.kind === 'done' && (
          <>
            <p role="status" data-done>
              {s('ocrDone', { file: baseName(step.result.outputPath) })}
            </p>
            {step.result.stopped && <p>{s('ocrStoppedEarly')}</p>}
            {step.result.failed.length > 0 && (
              <p data-failed={step.result.failed.join(',')}>
                {s('ocrFailedItems', {
                  items: step.result.failed
                    .map((i) => items[i - 1]?.name || s('ocrPageLabel', { page: i }))
                    .join(', '),
                })}
              </p>
            )}
            <div className="modal-buttons">
              {props.onOpenResult && (
                <button
                  type="button"
                  className="btn btn-primary"
                  data-action="open-result"
                  onClick={() =>
                    props.onOpenResult?.((step as { result: RunOcrResult }).result.outputPath)
                  }
                >
                  {s('ocrOpenResult')}
                </button>
              )}
              <button type="button" className="btn btn-secondary" onClick={props.onClose}>
                {s('ocrClose')}
              </button>
            </div>
          </>
        )}
        {step.kind === 'review' && (
          <>
            <p role="status" data-review="">
              {s('ocrReviewSummary', {
                read: collectedRef.current.size,
                total: requestedRef.current.size,
              })}
            </p>
            <ul className="translate-ocr-problems" data-problems="">
              {step.problems.map((problem) => {
                const where = items[problem.index - 1]?.location
                  ? ` (${items[problem.index - 1]!.location})`
                  : ''
                const text =
                  problem.kind === 'empty'
                    ? s('ocrReviewEmpty', { n: problem.index, where })
                    : problem.kind === 'stopped'
                      ? `${s('ocrPictureNumber', { n: problem.index })}${where}: ${s('ocrReviewStopped')}`
                      : s('ocrReviewFailed', {
                          n: problem.index,
                          where,
                          reason:
                            problem.kind === 'malformed'
                              ? s('ocrReviewMalformed')
                              : problem.message,
                        })
                return (
                  <li key={problem.index} data-problem={problem.index} data-kind={problem.kind}>
                    {text}
                  </li>
                )
              })}
            </ul>
            <div className="modal-buttons">
              <button type="button" className="btn btn-secondary" onClick={close}>
                {s('ocrClose')}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                data-action="use-read"
                disabled={collectedRef.current.size === 0}
                onClick={() => void acceptRead(step.problems)}
              >
                {s('ocrUseRead')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                data-action="retry"
                onClick={() => void retry(step.problems)}
              >
                {s('ocrRetryFailed')}
              </button>
            </div>
          </>
        )}
        {step.kind === 'error' && (
          <>
            <p className="projects-note is-warning" role="alert">
              {step.text}
            </p>
            <div className="modal-buttons">
              <button type="button" className="btn btn-secondary" onClick={props.onClose}>
                {s('ocrClose')}
              </button>
            </div>
          </>
        )}
      </div>
      {lightbox !== null && api && hasPictureKind(prepared) && (
        <OcrImageLightbox
          api={api}
          token={prepared.token}
          items={items}
          start={lightbox}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  )
}

/** the price and transfer confirmation; Start is the only button that sends */
function OcrConfirm(props: {
  count: number
  route: OcrRoute | null
  connection: SubscriptionConnection
  lang: ReturnType<typeof useI18n>['lang']
  onOpenAiSettings: () => void
  onBack: () => void
  onCancel: () => void
  onStart: () => void
}): ReactElement {
  const { count, route, connection, lang } = props
  const s = makeText(lang)
  const ready = route?.state === 'ready' ? route : null
  const vision = ready ? aiReadVisionCheck(ready.provider, ready.model) : null
  const visionText =
    !ready || !vision || vision.ok
      ? null
      : vision.reason === 'model-without-vision'
        ? s('ocrVisionModel', { model: ready.model || aiProviderDisplayName(ready.provider) })
        : vision.reason === 'provider-without-vision'
          ? s('ocrVisionProvider', { provider: aiProviderDisplayName(ready.provider) })
          : s('ocrVisionUnknown')
  const canStart = !!ready && !!vision?.ok
  const label = ready
    ? ready.model
      ? `${aiProviderDisplayName(ready.provider)} · ${ready.model}`
      : aiProviderDisplayName(ready.provider)
    : null
  return (
    <>
      <ul className="translate-ocr-summary" data-confirm>
        <li data-count={count}>{s('ocrConfirmCount', { count })}</li>
        {(!route || route.state === 'checking') && (
          <li data-route="checking">{s('ocrChecking')}</li>
        )}
        {route?.state === 'notice' && <li data-route="notice">{s('ocrNoticeFirst')}</li>}
        {ready && label && (
          <>
            <li data-route="ready" data-provider={ready.provider}>
              {s('ocrConfirmProvider', { provider: label })}
            </li>
            <li>{s('ocrConfirmSends')}</li>
            {ready.paid && (
              <li className="translate-ocr-paid" data-paid>
                {s('ocrConfirmPaid', { provider: aiProviderDisplayName(ready.provider) })}
              </li>
            )}
          </>
        )}
      </ul>
      {visionText && (
        <p className="projects-note is-warning" role="alert" data-error="vision">
          {visionText}
        </p>
      )}
      {route?.state === 'connect' && (
        <AiConnectPrompt
          choice={route.choice}
          statuses={connection.statuses}
          lang={lang}
          disabled={connection.busy}
          onOpenSettings={props.onOpenAiSettings}
          onInstall={connection.install}
          onUpdate={connection.update}
          onCancelLogin={connection.cancelLogin}
          onLogin={connection.login}
          onRecheck={connection.recheck}
          onAcceptMetered={(provider) => void connection.acceptMetered(provider)}
          onOpenInstallHelp={connection.openInstallHelp}
          onOpenConnectHelp={connection.openConnectHelp}
        />
      )}
      <div className="modal-buttons">
        <button
          type="button"
          className="btn btn-secondary"
          data-action="back"
          onClick={props.onBack}
        >
          {s('ocrBack')}
        </button>
        <button type="button" className="btn btn-secondary" onClick={props.onCancel}>
          {s('cancel')}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          data-action="start"
          disabled={!canStart}
          onClick={props.onStart}
        >
          {s('ocrStart')}
        </button>
      </div>
    </>
  )
}
