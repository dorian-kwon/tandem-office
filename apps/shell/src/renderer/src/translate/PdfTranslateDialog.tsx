import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { AiProviderId, AiSettings } from '@genoffice/ai-provider/browser'
import { AiConnectPrompt, aiProviderDisplayName } from '@genoffice/ui'
import type { DocumentJobEstimate } from '../../../../../../packages/pdf-structure/src/jobs/job'
import type { TranslationSend } from '../../../../../../packages/pdf-structure/src/translate'
import { routeLabel } from '../../../../../pdf/src/renderer/doc-jobs/route'
import type { TranslateApi } from '../../../shared/translate-api'
import {
  PdfTranslateCancelledError,
  runPdfTranslation,
  type PdfTranslateBridge,
  type PdfTranslateGo,
  type RunPdfTranslationResult,
} from '../../../shared/translate-pdf'
import { useI18n } from '../locale'
import type { SubscriptionConnection } from '../subscription-client'
import { createRouteAsk } from './ocr-ask'
import { pdfJobRoute, pdfRouteRefusal, type PdfJobRoute } from './pdf-route'
import { languageName, makeText, translateErrorText } from './shared'

/**
 * The translation window for a project's text PDF (spec 6.4): the price and
 * transfer confirmation with the engine's own estimate and the bilingual
 * option, then the job with its progress and Stop, then the translated PDF
 * in output/, opened beside the read-only source copy.
 *
 * Start is the only thing that sends. It is enabled only when the AI route
 * (the PDF editor's document-job route, `pdfJobRoute`) can run now; the
 * connect prompt and the first-connection notice (the home screen's dialog,
 * `onNoticeNeeded`) come up as in the other home panels. Every call checks
 * again that the confirmed route still holds and stops the job otherwise.
 *
 * A stopped job keeps what is done in the result store: "Write what is done"
 * writes the PDF now (the rest stays in the source language), "Continue
 * later" closes, and the next start sends only what is missing.
 */

export interface PdfTranslateDialogProps {
  /** a registered translation project */
  dir: string
  /** the plain file name of the PDF source */
  file: string
  aiSettings: AiSettings | null
  connection: SubscriptionConnection
  onNoticeNeeded?: () => void
  onOpenAiSettings: () => void
  /** open the written PDF beside the source copy (called once it is written) */
  onOpenResult?: (output: string) => void
  onClose: () => void
  /** the bridge; default window.translateApi (tests pass a fake) */
  api?: TranslateApi
  /** the model call for a confirmed route; default the shared ai:stream call */
  makeSend?: (
    confirmed: Extract<PdfJobRoute, { state: 'ready' }>,
    refusal: () => string | null,
  ) => TranslationSend
}

type Step =
  | { kind: 'loading' }
  | { kind: 'confirm'; estimate: DocumentJobEstimate }
  | { kind: 'running'; done: number; total: number }
  | { kind: 'writing' }
  | { kind: 'done'; output: string }
  | { kind: 'stopped'; result: RunPdfTranslationResult }
  | { kind: 'error'; text: string }

function bridgeOf(api: TranslateApi): PdfTranslateBridge {
  return {
    prepare: (dir, file) => api.pdfPrepare({ dir, file }),
    store: (token, request) => api.pdfStore({ token, request }),
    write: (token, bilingual) => api.pdfWrite({ token, bilingual }),
    release: (token) => api.pdfRelease(token),
    instructions: (dir, text) => api.instructionsFor({ dir, text }),
  }
}

export function PdfTranslateDialog(props: PdfTranslateDialogProps): ReactElement {
  const { lang } = useI18n()
  const s = makeText(lang)
  const api = props.api ?? window.translateApi
  const [step, setStep] = useState<Step>({ kind: 'loading' })
  const [bilingual, setBilingual] = useState(false)
  const [targetLang, setTargetLang] = useState<string | null>(null)
  const propsRef = useRef(props)
  propsRef.current = props
  const route = pdfJobRoute(props.aiSettings, props.connection.statuses)
  const routeRef = useRef(route)
  routeRef.current = route
  /** answers the pending confirmation */
  const answerRef = useRef<((go: PdfTranslateGo | null) => void) | null>(null)
  const runRef = useRef<AbortController | null>(null)
  /** a stopped job's token, held for "Write what is done" */
  const heldRef = useRef<string | null>(null)

  useEffect(() => {
    let alive = true
    if (!api) {
      setStep({ kind: 'error', text: translateErrorText(lang, new Error('[TRANSLATE_FAILED]')) })
      return
    }
    const controller = new AbortController()
    runRef.current = controller
    const now = () => routeRef.current
    void runPdfTranslation({
      dir: props.dir,
      file: props.file,
      bridge: bridgeOf(api),
      model: () => {
        const r = now()
        return r.state === 'ready'
          ? { provider: r.provider, model: r.model }
          : { provider: '', model: '' }
      },
      confirm: (estimate, prepared) =>
        new Promise<PdfTranslateGo | null>((resolve) => {
          if (!alive) return resolve(null)
          setTargetLang(prepared.lang)
          answerRef.current = resolve
          setStep({ kind: 'confirm', estimate })
        }),
      signal: controller.signal,
      onProgress: (e) => {
        if (alive) setStep({ kind: 'running', done: e.done, total: e.total })
      },
      onWriting: () => {
        if (alive) setStep({ kind: 'writing' })
      },
    }).then(
      (result) => {
        runRef.current = null
        if (!alive) {
          if (result.token) void api.pdfRelease(result.token).catch(() => undefined)
          return
        }
        if (result.output) {
          setStep({ kind: 'done', output: result.output })
          propsRef.current.onOpenResult?.(result.output)
          return
        }
        heldRef.current = result.token
        setStep({ kind: 'stopped', result })
      },
      (err: unknown) => {
        runRef.current = null
        if (!alive) return
        if (err instanceof PdfTranslateCancelledError) {
          propsRef.current.onClose()
          return
        }
        setStep({ kind: 'error', text: translateErrorText(lang, err) })
      },
    )
    return () => {
      alive = false
      answerRef.current?.(null)
      answerRef.current = null
      controller.abort()
      if (heldRef.current) void api.pdfRelease(heldRef.current).catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opened window
  }, [])

  // the confirmation needs the first-connection notice: ask the home screen for it
  const noticeAsked = useRef(false)
  useEffect(() => {
    if (step.kind === 'confirm' && route.state === 'notice' && !noticeAsked.current) {
      noticeAsked.current = true
      propsRef.current.onNoticeNeeded?.()
    }
  }, [step.kind, route.state])

  const answer = (go: PdfTranslateGo | null) => {
    const resolve = answerRef.current
    answerRef.current = null
    resolve?.(go)
  }

  const start = () => {
    const r = routeRef.current
    if (step.kind !== 'confirm') return
    if (step.estimate.calls === 0) {
      // everything is stored already: no call is made, the PDF is only written
      setStep({ kind: 'running', done: step.estimate.done, total: step.estimate.total })
      answer({
        send: () => Promise.reject(new PdfTranslateCancelledError()),
        model: r.state === 'ready' ? { provider: r.provider, model: r.model } : step.estimate.model,
        bilingual,
      })
      return
    }
    if (r.state !== 'ready') return
    const refusal = () =>
      pdfRouteRefusal(r, propsRef.current.aiSettings, propsRef.current.connection.statuses)
    const send: TranslationSend = props.makeSend
      ? props.makeSend(r, refusal)
      : (() => {
          const ask = createRouteAsk({
            settings: () => r.settings,
            refusal,
            lang: () => lang,
            unknownError: 'errTranslateFailed',
          })
          // the engine's request: its instruction as the system prompt, the blocks as one
          // user turn of document data; no tools
          return (request, signal) =>
            ask(request.system, [{ role: 'user', text: request.prompt }], signal)
        })()
    setStep({ kind: 'running', done: step.estimate.done, total: step.estimate.total })
    answer({ send, model: { provider: r.provider, model: r.model }, bilingual })
  }

  const cancel = () => {
    answer(null)
    runRef.current?.abort()
    props.onClose()
  }

  const writeDone = () => {
    const token = heldRef.current
    if (!api || !token || step.kind !== 'stopped') return
    const chosen = step.result.bilingual
    heldRef.current = null
    setStep({ kind: 'writing' })
    api.pdfWrite({ token, bilingual: chosen }).then(
      ({ output }) => {
        setStep({ kind: 'done', output })
        propsRef.current.onOpenResult?.(output)
      },
      (err: unknown) => setStep({ kind: 'error', text: translateErrorText(lang, err) }),
    )
  }

  const title = step.kind === 'confirm' ? s('trConfirmTitle') : s('trTitle')

  return (
    <div className="modal-overlay">
      <div
        className="modal translate-ocr translate-pdf"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-step={step.kind}
      >
        <h3>{title}</h3>
        {step.kind === 'loading' && (
          <>
            <p role="status" data-loading>
              {s('trLoading')}
            </p>
            <div className="modal-buttons">
              <button type="button" className="btn btn-secondary" onClick={cancel}>
                {s('cancel')}
              </button>
            </div>
          </>
        )}
        {step.kind === 'confirm' && (
          <PdfConfirm
            estimate={step.estimate}
            targetLang={targetLang}
            route={route}
            bilingual={bilingual}
            onBilingual={setBilingual}
            connection={props.connection}
            lang={lang}
            onOpenAiSettings={props.onOpenAiSettings}
            onCancel={cancel}
            onStart={start}
          />
        )}
        {step.kind === 'running' && (
          <>
            <p role="status" data-progress={`${step.done}/${step.total}`}>
              {s('trRunning', { done: step.done, total: step.total })}
            </p>
            <div className="modal-buttons">
              <button
                type="button"
                className="btn btn-secondary"
                data-action="stop"
                onClick={() => runRef.current?.abort()}
              >
                {s('trStop')}
              </button>
            </div>
          </>
        )}
        {step.kind === 'writing' && (
          <p role="status" data-writing>
            {s('trWriting')}
          </p>
        )}
        {step.kind === 'done' && (
          <>
            <p role="status" data-done>
              {s('trDone', { file: step.output })}
            </p>
            <div className="modal-buttons">
              {props.onOpenResult && (
                <button
                  type="button"
                  className="btn btn-primary"
                  data-action="open-result"
                  onClick={() => props.onOpenResult?.((step as { output: string }).output)}
                >
                  {s('trOpenResult')}
                </button>
              )}
              <button type="button" className="btn btn-secondary" onClick={props.onClose}>
                {s('trClose')}
              </button>
            </div>
          </>
        )}
        {step.kind === 'stopped' && (
          <>
            <p role="status" data-stopped={step.result.summary.stopReason ?? ''}>
              {step.result.summary.stopReason && step.result.summary.stopReason !== 'cancelled'
                ? s('trStoppedError', { reason: step.result.summary.stopReason })
                : s('trStopped', {
                    done: step.result.summary.progress.done,
                    total: step.result.summary.progress.total,
                  })}
            </p>
            <div className="modal-buttons">
              {step.result.summary.progress.done > 0 && (
                <button
                  type="button"
                  className="btn btn-primary"
                  data-action="write-partial"
                  onClick={writeDone}
                >
                  {s('trWritePartial')}
                </button>
              )}
              <button
                type="button"
                className="btn btn-secondary"
                data-action="later"
                onClick={props.onClose}
              >
                {s('trLater')}
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
                {s('trClose')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** a recorded provider id as the screen names it (the id itself when unknown) */
function providerName(id: string | null): string {
  if (!id) return '?'
  return aiProviderDisplayName(id as AiProviderId) || id
}

/** the price and transfer confirmation; Start is the only button that sends */
function PdfConfirm(props: {
  estimate: DocumentJobEstimate
  targetLang: string | null
  route: PdfJobRoute
  bilingual: boolean
  onBilingual: (on: boolean) => void
  connection: SubscriptionConnection
  lang: ReturnType<typeof useI18n>['lang']
  onOpenAiSettings: () => void
  onCancel: () => void
  onStart: () => void
}): ReactElement {
  const { estimate, route, connection, lang } = props
  const s = makeText(lang)
  const ready = route.state === 'ready' ? route : null
  const nothing = estimate.calls === 0
  const change = estimate.providerChange
  return (
    <>
      <ul className="translate-ocr-summary" data-confirm>
        {props.targetLang && (
          <li data-lang={props.targetLang}>
            {s('trConfirmLanguage', { language: languageName(lang, props.targetLang) })}
          </li>
        )}
        {nothing ? (
          <li data-calls={0}>{s('trConfirmNothing')}</li>
        ) : (
          <li data-calls={estimate.calls}>
            {s('trConfirmCalls', {
              calls: estimate.calls,
              pending: estimate.pending,
              total: estimate.total,
            })}
          </li>
        )}
        {estimate.done > 0 && !nothing && (
          <li data-done-before={estimate.done}>{s('trConfirmDone', { done: estimate.done })}</li>
        )}
        {route.state === 'checking' && <li data-route="checking">{s('trChecking')}</li>}
        {route.state === 'notice' && <li data-route="notice">{s('trNoticeFirst')}</li>}
        {ready && !nothing && (
          <>
            <li data-route="ready" data-provider={ready.provider}>
              {s('trConfirmProvider', { provider: routeLabel(ready, connection.statuses) })}
            </li>
            <li>{s('trConfirmSends')}</li>
            {ready.paid && (
              <li className="translate-ocr-paid" data-paid>
                {s('trConfirmPaid', { provider: aiProviderDisplayName(ready.provider) })}
              </li>
            )}
            {change && (
              <li data-provider-change>
                {s('trProviderChange', {
                  before: providerName(change.stored.provider),
                  after: providerName(change.next.provider),
                })}
              </li>
            )}
          </>
        )}
      </ul>
      <label className="translate-pdf-bilingual">
        <input
          type="checkbox"
          data-option="bilingual"
          checked={props.bilingual}
          onChange={(e) => props.onBilingual(e.target.checked)}
        />
        <span>{s('trBilingual')}</span>
      </label>
      {route.state === 'connect' && !nothing && (
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
        <button type="button" className="btn btn-secondary" onClick={props.onCancel}>
          {s('cancel')}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          data-action="start"
          disabled={!ready && !nothing}
          onClick={props.onStart}
        >
          {s('trStart')}
        </button>
      </div>
    </>
  )
}
