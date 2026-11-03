import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { AiProviderId, AiSettings } from '@genoffice/ai-provider/browser'
import {
  AiConnectPrompt,
  aiProviderDisplayName,
  aiRunErrorText,
  type AiRunErrorCause,
} from '@genoffice/ui'
import type { Lang } from '@genoffice/i18n'
import type { DocumentJobEstimate } from '../../../../../../packages/pdf-structure/src/jobs/job'
import type { TranslationSend } from '../../../../../../packages/pdf-structure/src/translate'
import { routeLabel } from '../../../../../pdf/src/renderer/doc-jobs/route'
import type { TranslateApi, TranslateContextSummary } from '../../../shared/translate-api'
import {
  canContinue,
  PdfTranslateCancelledError,
  runPdfTranslation,
  type PdfTranslateEstimates,
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
  /**
   * the newest earlier translated PDF in output/ (in the current target
   * language), or null: the window then starts with a choice, and "Open it"
   * opens that file without any AI call
   */
  existing?: string | null
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
  /** an earlier result or stored progress: continue, translate again, or open the result */
  | { kind: 'choose'; estimates: PdfTranslateEstimates }
  /** the confirmation, with the estimate of the chosen mode */
  | { kind: 'confirm'; estimates: PdfTranslateEstimates; restart: boolean }
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
  /** what of the project goes with every request; read once, sends nothing */
  const [context, setContext] = useState<TranslateContextSummary | null>(null)
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
    // a read of the project's composition with no request text, for the confirmation;
    // it calls no AI (the glossary entries of each request are picked per block later)
    api.instructionsFor({ dir: props.dir, text: '' }).then(
      (answer) => {
        if (alive && answer?.summary) setContext(answer.summary)
      },
      () => undefined,
    )
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
      confirm: (estimates, prepared) =>
        new Promise<PdfTranslateGo | null>((resolve) => {
          if (!alive) return resolve(null)
          setTargetLang(prepared.lang)
          answerRef.current = resolve
          // an earlier result or stored progress: the person chooses first; otherwise
          // this is a first translation and goes straight to its confirmation
          const choose = !!propsRef.current.existing || estimates.resume.done > 0
          setStep(
            choose ? { kind: 'choose', estimates } : { kind: 'confirm', estimates, restart: false },
          )
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
    const { restart } = step
    const estimate = restart ? step.estimates.restart : step.estimates.resume
    if (estimate.calls === 0) {
      // everything is stored already: no call is made, the PDF is only written
      setStep({ kind: 'running', done: estimate.done, total: estimate.total })
      answer({
        send: () => Promise.reject(new PdfTranslateCancelledError()),
        model: r.state === 'ready' ? { provider: r.provider, model: r.model } : estimate.model,
        bilingual,
        restart,
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
    setStep({ kind: 'running', done: restart ? 0 : estimate.done, total: estimate.total })
    answer({ send, model: { provider: r.provider, model: r.model }, bilingual, restart })
  }

  /** the choice made: its own confirmation, with that mode's estimate */
  const choose = (restart: boolean) => {
    if (step.kind !== 'choose') return
    setStep({ kind: 'confirm', estimates: step.estimates, restart })
  }

  const openExisting = () => {
    const existing = props.existing
    answer(null)
    runRef.current?.abort()
    if (existing) props.onOpenResult?.(existing)
    props.onClose()
  }

  const cancel = () => {
    answer(null)
    runRef.current?.abort()
    props.onClose()
  }

  /** write what is done; the token stays held (and is released on close) until it is written */
  const writeDone = () => {
    const token = heldRef.current
    if (!api || !token || step.kind !== 'stopped') return
    const chosen = step.result.bilingual
    setStep({ kind: 'writing' })
    api.pdfWrite({ token, bilingual: chosen }).then(
      ({ output }) => {
        heldRef.current = null
        setStep({ kind: 'done', output })
        propsRef.current.onOpenResult?.(output)
      },
      (err: unknown) => setStep({ kind: 'error', text: translateErrorText(lang, err) }),
    )
  }

  const title =
    step.kind === 'confirm'
      ? s('trConfirmTitle')
      : step.kind === 'choose'
        ? s('existingTitle')
        : s('trTitle')

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
        {step.kind === 'choose' && (
          <PdfChoose
            estimates={step.estimates}
            existing={props.existing ?? null}
            lang={lang}
            onContinue={() => choose(false)}
            onAgain={() => choose(true)}
            onOpenExisting={openExisting}
            onCancel={cancel}
          />
        )}
        {(step.kind === 'confirm' || step.kind === 'running') && context && (
          <ContextSummary summary={context} lang={lang} />
        )}
        {step.kind === 'confirm' && (
          <PdfConfirm
            estimate={step.restart ? step.estimates.restart : step.estimates.resume}
            restart={step.restart}
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
              {stoppedText(step.result, lang)}
            </p>
            {route.state === 'notice' && <p data-route="notice">{s('trNoticeFirst')}</p>}
            {route.state === 'connect' && (
              <AiConnectPrompt
                choice={route.choice}
                statuses={props.connection.statuses}
                lang={lang}
                disabled={props.connection.busy}
                onOpenSettings={props.onOpenAiSettings}
                onInstall={props.connection.install}
                onUpdate={props.connection.update}
                onCancelLogin={props.connection.cancelLogin}
                onLogin={props.connection.login}
                onRecheck={props.connection.recheck}
                onAcceptMetered={(provider) => void props.connection.acceptMetered(provider)}
                onOpenInstallHelp={props.connection.openInstallHelp}
                onOpenConnectHelp={props.connection.openConnectHelp}
              />
            )}
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

/**
 * Why the job stopped, in the screen language: Stop, several failures in a
 * row, a store write, or the AI's own run error (a usage limit, signed out,
 * …) worded by the app's shared run-error text.
 */
function stoppedText(result: RunPdfTranslationResult, lang: Lang): string {
  const s = makeText(lang)
  const { stopReason, resetsAt, progress } = result.summary
  if (!stopReason || stopReason === 'cancelled' || stopReason === 'interrupted')
    return s('trStopped', { done: progress.done, total: progress.total })
  if (stopReason === 'failures') return s('trStoppedFailures')
  if (stopReason === 'store-write-failed') return s('trStoppedStore')
  const text = aiRunErrorText(lang, {
    kind: stopReason as AiRunErrorCause['kind'],
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  })
  return text ?? s('trStopped', { done: progress.done, total: progress.total })
}

/**
 * The choice when an earlier result or stored progress exists. "Continue"
 * (the primary action) only when part is stored and part is still to do: it
 * sends only the rest. "Translate again" sends everything. "Open it" opens
 * the earlier result. When everything is stored but no PDF was written yet,
 * "Write the PDF" writes it without any call. Each sending choice goes on
 * to its own confirmation; nothing is sent from here.
 */
function PdfChoose(props: {
  estimates: PdfTranslateEstimates
  existing: string | null
  lang: Lang
  onContinue: () => void
  onAgain: () => void
  onOpenExisting: () => void
  onCancel: () => void
}): ReactElement {
  const s = makeText(props.lang)
  const { resume } = props.estimates
  const more = canContinue(resume)
  const writeStored = !props.existing && resume.done > 0 && resume.pending === 0
  return (
    <>
      {props.existing && (
        <p data-existing={props.existing}>{s('existingText', { file: props.existing })}</p>
      )}
      {resume.done > 0 && (
        <p data-progress-stored={`${resume.done}/${resume.total}`}>
          {s('trStoredProgress', { done: resume.done, total: resume.total })}
        </p>
      )}
      <div className="modal-buttons">
        <button type="button" className="btn btn-secondary" onClick={props.onCancel}>
          {s('cancel')}
        </button>
        {props.existing && (
          <button
            type="button"
            className={more ? 'btn btn-secondary' : 'btn btn-primary'}
            data-action="open-existing"
            onClick={props.onOpenExisting}
          >
            {s('existingOpen')}
          </button>
        )}
        <button
          type="button"
          className="btn btn-secondary"
          data-action="again"
          onClick={props.onAgain}
        >
          {s('existingAgainPdf')}
        </button>
        {writeStored && (
          <button
            type="button"
            className="btn btn-primary"
            data-action="write-stored"
            onClick={props.onContinue}
          >
            {s('trWriteStored')}
          </button>
        )}
        {more && (
          <button
            type="button"
            className="btn btn-primary"
            data-action="continue"
            onClick={props.onContinue}
          >
            {s('trContinue', { pending: resume.pending })}
          </button>
        )}
      </div>
    </>
  )
}

/**
 * The project context every request of this job carries (spec 6.6): the two
 * prompts, the glossary and the reference file names, as main composes them.
 */
function ContextSummary(props: { summary: TranslateContextSummary; lang: Lang }): ReactElement {
  const s = makeText(props.lang)
  const { summary } = props
  const glossary =
    summary.glossaryTotal === 0
      ? s('ctxGlossaryNone')
      : summary.glossaryTotal <= summary.glossaryLimit
        ? s('ctxGlossaryAll', { count: summary.glossaryTotal })
        : s('ctxGlossaryPerBlock', { count: summary.glossaryTotal, limit: summary.glossaryLimit })
  const references = summary.referenceNames
  return (
    <div className="translate-ocr-summary" data-context>
      <p>{s('ctxTitle')}</p>
      <ul>
        <li data-context-system={summary.systemPrompt}>
          {summary.systemPrompt ? s('ctxSystemOn') : s('ctxSystemOff')}
        </li>
        <li data-context-project={summary.projectPrompt}>
          {summary.projectPrompt ? s('ctxProjectOn') : s('ctxProjectOff')}
        </li>
        <li data-context-glossary={summary.glossaryTotal}>{glossary}</li>
        <li data-context-references={references.length}>
          {references.length === 0
            ? s('ctxReferencesNone')
            : s('ctxReferences', { count: references.length, names: references.join(', ') })}
        </li>
      </ul>
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
  restart: boolean
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
        {props.restart && <li data-restart>{s('trConfirmRestart')}</li>}
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
            <li data-hint="app-ai">{s('trConfirmAppAi')}</li>
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
