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
  type RunOcrResult,
} from '../../../shared/translate-ocr'
import { useI18n } from '../locale'
import type { SubscriptionConnection } from '../subscription-client'
import { createOcrAsk } from './ocr-ask'
import { ocrRoute, type OcrRoute } from './ocr-route'
import { makeText, translateErrorText } from './shared'

/**
 * The translation OCR window (spec 6.5): pick the pages of a scanned PDF or
 * the image files to read, then the price and transfer confirmation, then
 * the run. Nothing is selected at first; "Select all" and "Clear selection"
 * are there, and Next stays disabled while nothing is chosen.
 *
 * The confirmation shows how many items go out, to which AI (the project's
 * OCR choice, through the app's own connection and send gate, `ocrRoute`),
 * that the page images are sent, and "<provider> will charge for this" on an
 * accepted metered login. Start is the only thing that sends: it is enabled
 * only when that AI can run now and reads images. Back and Cancel send
 * nothing. The first-connection notice is the home screen's dialog
 * (`onNoticeNeeded`), as for the other home panels.
 *
 * The run itself is `runOcr`; its result is a Word document in output/.
 */

export interface OcrSelectDialogProps {
  /** a registered translation project */
  dir: string
  /** one PDF source, or one or more image sources in reading order */
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
  onOpenResult?: (docxPath: string) => void
  onClose: () => void
  /** the bridge; default window.translateApi (tests pass a fake) */
  api?: TranslateApi
  /** the model call for a confirmed route; default the shared ai:stream call */
  makeAsk?: (confirmed: Extract<OcrRoute, { state: 'ready' }>, current: () => OcrRoute) => OcrAsk
}

type Step =
  | { kind: 'loading' }
  | { kind: 'pick' }
  | { kind: 'confirm'; count: number }
  | { kind: 'running'; progress: OcrProgress }
  | { kind: 'done'; result: RunOcrResult }
  | { kind: 'error'; text: string }

function ocrBridge(api: TranslateApi): OcrBridge {
  return {
    prepare: (dir, files) => api.ocrPrepare({ dir, files }),
    start: (token, pages) => api.ocrStart({ token, pages }),
    pageImage: (token, index) => api.ocrPageImage({ token, index }),
    write: (token, pages) => api.ocrWrite({ token, pages }),
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
  /** Back was pressed: the cancelled run returns to the picker */
  const backRef = useRef(false)
  const askRef = useRef<OcrAsk | null>(null)
  const runRef = useRef<AbortController | null>(null)
  const tokenRef = useRef<string | null>(null)

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
        setStep({ kind: 'pick' })
      },
      (err: unknown) => {
        if (alive) setStep({ kind: 'error', text: translateErrorText(lang, err) })
      },
    )
    return () => {
      alive = false
      answerRef.current?.(false)
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

  const next = () => {
    if (!api || !prepared || selected.size === 0) return
    backRef.current = false
    const controller = new AbortController()
    runRef.current = controller
    void runOcr({
      dir: props.dir,
      source: props.sources,
      selection: { kind: 'pages', pages: [...selected] },
      prepared,
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
        if (err instanceof OcrCancelledError && backRef.current) {
          setStep({ kind: 'pick' })
          return
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
      : createOcrAsk({ confirmed: r, ocr: prepared.ocr.provider, current, lang: () => lang })
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
    runRef.current?.abort()
    props.onClose()
  }

  const title = step.kind === 'confirm' ? s('ocrConfirmTitle') : s('ocrTitle')

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
        {step.kind === 'pick' && (
          <>
            <p>{s('ocrIntro')}</p>
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
                    <span>{item.name || s('ocrPageLabel', { page: item.index })}</span>
                  </label>
                </li>
              ))}
            </ul>
            <p className="translate-ocr-count" data-selected-count={selected.size}>
              {s('ocrSelectedCount', { count: selected.size, total: items.length })}
            </p>
            {selected.size === 0 && <p className="projects-hint">{s('ocrNothingSelected')}</p>}
            <div className="modal-buttons">
              <button type="button" className="btn btn-secondary" onClick={close}>
                {s('cancel')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                data-action="next"
                disabled={selected.size === 0}
                onClick={next}
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
                onClick={() => runRef.current?.abort()}
              >
                {s('ocrStop')}
              </button>
            </div>
          </>
        )}
        {step.kind === 'done' && (
          <>
            <p role="status" data-done>
              {s('ocrDone', { file: baseName(step.result.docxPath) })}
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
                    props.onOpenResult?.((step as { result: RunOcrResult }).result.docxPath)
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
