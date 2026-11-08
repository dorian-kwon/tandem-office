/**
 * The "AI compare" popup: asks Gemini, Claude and Copilot (their web pages, driven
 * through ego lite in the main process) to check and polish the selected English
 * text against its Korean original, lists every candidate as a card, and replaces
 * the selection with the one the person picks.
 *
 * It is an in-page floating panel, movable by its title bar and clamped to the
 * editor area. It never takes the document selection: the selected range and a
 * fingerprint of its text are stored when it opens, and "use this" replaces
 * exactly that range (refused when the text under it changed).
 */
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { Editor } from '@tiptap/core'
import { aiSendGate } from '@genoffice/ui'
import type { AiSettings } from '@genoffice/ai-provider/browser'
import { useI18n, type StringKey } from '../i18n/locale'
import { setInactiveSelectionShown } from '../editor/inactive-selection'
import { COMPARE_SITES, EGO_INSTALL_URL } from '../../shared/compare-sites'
import type { CompareAnswer, CompareDriverClient, EgoDetection } from '../../shared/compare'
import { authorName } from '../author-name'
import { useSubscriptionConnection } from '../ai/subscription-client'
import {
  COMPARE_TEXT_MAX_CHARS,
  buildComparePrompt,
  buildIntegrationRequest,
  capText,
  languageName,
} from '../compare/prompts'
import { clampToBounds, dragPosition, type Box } from '../compare/drag-clamp'
import { createCompareRun, type EngineStatus } from '../compare/run-state'
import {
  replaceSnapshot,
  type ReplaceResult,
  type SelectionSnapshot,
} from '../compare/replace-selection'
import { readKoreanSource } from '../compare/source-locate'

interface Props {
  editor: Editor
  /** the range and text fingerprint of the selection the popup was opened on */
  snapshot: SelectionSnapshot
  settings: AiSettings
  /** the tracked-changes toggle: a replacement is then recorded as a revision */
  trackChanges: boolean
  onClose: () => void
}

const WIDTH = 540
const MARGIN = 8

const siteNames = COMPARE_SITES.map((site) => site.name).join(', ')

const STATUS_KEYS: Record<EngineStatus, StringKey> = {
  waiting: 'cmpStWaiting',
  running: 'cmpStRunning',
  done: 'cmpStDone',
  failed: 'cmpStFailed',
  stopped: 'cmpStStopped',
  skipped: 'cmpStSkipped',
  needsUser: 'cmpStNeedsUser',
}

/** the editor area, in viewport coordinates: the popup may not leave it */
function editorBounds(): Box {
  const el = document.querySelector('.editor-area')
  const r = el?.getBoundingClientRect()
  if (r && r.width > 0 && r.height > 0)
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
}

/** the driver as the renderer sees it: every call goes to the main process */
function ipcDriver(): CompareDriverClient {
  return {
    async detect(): Promise<EgoDetection> {
      return (await window.desktop?.compareDetect?.()) ?? { installed: false }
    },
    async ask(siteId, prompt, signal): Promise<CompareAnswer> {
      const api = window.desktop
      if (!api?.compareAsk) return { ok: false, reason: 'not available in this window' }
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
      const cancel = (): void => void api.compareCancel?.(id)
      signal.addEventListener('abort', cancel, { once: true })
      try {
        return await api.compareAsk({ id, siteId, prompt })
      } finally {
        signal.removeEventListener('abort', cancel)
      }
    },
  }
}

type MissingStep = 'ask' | 'steps' | 'later'

export function AiComparePopover({
  editor,
  snapshot,
  settings,
  trackChanges,
  onClose,
}: Props): React.JSX.Element {
  const { t, lang } = useI18n()
  const subscription = useSubscriptionConnection()
  const rootRef = useRef<HTMLDivElement>(null)
  const english = useMemo(
    () => editor.state.doc.textBetween(snapshot.from, snapshot.to, '\n', '\n').trim(),
    [editor, snapshot],
  )
  const [consent, setConsent] = useState<boolean | null>(null)
  const [detection, setDetection] = useState<EgoDetection | 'checking'>('checking')
  const [missing, setMissing] = useState<MissingStep>('ask')
  // the Korean original is optional: found in a translation project, or added by the person
  const [korean, setKorean] = useState('')
  const [autoFilled, setAutoFilled] = useState(false)
  const [showOriginal, setShowOriginal] = useState(false)
  // the language of the project's target (or the screen language outside a project); null until known
  const [targetCode, setTargetCode] = useState<string | null>(null)
  const [lookupDone, setLookupDone] = useState(false)
  const autoStarted = useRef(false)
  const [auto, setAuto] = useState(true)
  // the sites also translate the Korean themselves (remembered in the small settings file)
  const [retranslate, setRetranslate] = useState(true)
  const [copied, setCopied] = useState<string | null>(null)
  const [notice, setNotice] = useState<StringKey | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  // latest values for the long-lived run (its integration step reads them when it runs)
  const englishSent = useMemo(() => capText(english), [english])
  const koreanSent = useMemo(() => capText(korean), [korean])
  const hasOriginal = koreanSent.text !== ''
  const targetName = languageName(targetCode ?? lang)
  const live = useRef({
    settings,
    statuses: subscription.statuses,
    korean: koreanSent.text,
    english: englishSent.text,
    target: targetName,
  })
  live.current = {
    settings,
    statuses: subscription.statuses,
    korean: koreanSent.text,
    english: englishSent.text,
    target: targetName,
  }

  const driver = useMemo(ipcDriver, [])
  const run = useMemo(
    () =>
      createCompareRun({
        driver,
        engineIds: COMPARE_SITES.map((s) => s.id),
        integrate: async (answers): Promise<CompareAnswer> => {
          const { settings: s, statuses, korean: ko, english: en, target } = live.current
          // the app's own AI only, and only when its send gate lets a run through
          if (aiSendGate(s, statuses).kind !== 'run' || !window.desktop?.aiChat)
            return { ok: false, reason: t('cmpBlocked') }
          const request = buildIntegrationRequest({
            korean: ko,
            original: en,
            ...(ko === '' ? { targetLanguage: target } : {}),
            answers: answers.map((a) => ({
              label: `${COMPARE_SITES.find((site) => site.id === a.id)?.name ?? a.id} (${a.kind === 'polished' ? 'polished' : 're-translated'})`,
              text: a.text,
            })),
          })
          const reply = await window.desktop.aiChat({ settings: s, ...request })
          return reply.ok && reply.content
            ? { ok: true, text: reply.content }
            : { ok: false, reason: reply.error ?? 'no answer' }
        },
      }),
    // `t` is deliberately not a dependency: the run is created once per popup
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [driver],
  )
  const state = useSyncExternalStore(run.subscribe, run.getState)
  useEffect(() => () => run.stop(), [run])
  useEffect(() => run.setAutoIntegrate(auto), [run, auto])

  const checkEgo = useCallback(() => {
    setDetection('checking')
    void driver.detect().then(
      (found) => setDetection(found),
      () => setDetection({ installed: false }),
    )
  }, [driver])

  useEffect(() => {
    let alive = true
    void Promise.resolve(window.desktop?.compareGetRetranslate?.())
      .then((v) => alive && typeof v === 'boolean' && setRetranslate(v))
      .catch(() => {})
    void Promise.resolve(window.desktop?.compareGetConsent?.())
      .then((v) => alive && setConsent(v === true))
      .catch(() => alive && setConsent(false))
    checkEgo()
    // best effort and silent: the target language of the translation project and the Korean
    // original of its document (found by block position) fill in by themselves
    const languages = Promise.resolve(window.desktop?.getTranslationLanguages?.())
      .then((pair) => alive && pair?.targetLang && setTargetCode(pair.targetLang))
      .catch(() => {})
    const original = readKoreanSource(editor, snapshot, window.desktop?.compareReadSource).then(
      (text) => {
        if (!alive || !text) return
        setKorean((current) => (current ? current : text))
        setAutoFilled(true)
        setShowOriginal(true)
      },
      () => {},
    )
    void Promise.all([languages, original]).then(() => alive && setLookupDone(true))
    return () => {
      alive = false
    }
  }, [editor, snapshot, checkEgo])

  // keep the selected range visible while the popup is open; it never takes the selection
  useEffect(() => {
    setInactiveSelectionShown(editor, true)
    return () => setInactiveSelectionShown(editor, false)
  }, [editor])

  // Esc closes from anywhere (the popup does not take focus)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const sizeOf = (): { width: number; height: number } => {
    const el = rootRef.current
    return { width: el?.offsetWidth ?? WIDTH, height: el?.offsetHeight ?? 300 }
  }

  // first placement: top right of the editor area; later the window or its content changing re-clamps
  useLayoutEffect(() => {
    const b = editorBounds()
    const inner: Box = {
      left: b.left + MARGIN,
      top: b.top + MARGIN,
      width: b.width - 2 * MARGIN,
      height: b.height - 2 * MARGIN,
    }
    setPos((current) =>
      clampToBounds(
        current ?? { left: inner.left + inner.width - WIDTH, top: inner.top },
        sizeOf(),
        inner,
      ),
    )
  }, [state, detection, consent, missing])
  useEffect(() => {
    const onResize = (): void => {
      const b = editorBounds()
      setPos((p) => (p ? clampToBounds(p, sizeOf(), b) : p))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const drag = useRef<{
    start: { left: number; top: number }
    at: { left: number; top: number }
  } | null>(null)
  const onTitleDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if ((e.target as HTMLElement).closest('button') || !pos) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { start: pos, at: { left: e.clientX, top: e.clientY } }
  }
  const onTitleMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d) return
    setPos(
      dragPosition(d.start, d.at, { left: e.clientX, top: e.clientY }, sizeOf(), editorBounds()),
    )
  }
  const onTitleUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    drag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId)
  }

  // the re-translation only applies when there is an original to translate from
  const asksRetranslation = retranslate && hasOriginal
  const prompt = useMemo(
    () =>
      buildComparePrompt(koreanSent.text, englishSent.text, {
        retranslate: asksRetranslation,
        targetLanguage: targetName,
      }),
    [koreanSent.text, englishSent.text, asksRetranslation, targetName],
  )
  const canStart = consent === true && englishSent.text !== ''
  const installed = detection !== 'checking' && detection.installed
  // no input is needed: once the person agreed, ego lite is there and the lookup finished, it starts
  useEffect(() => {
    if (autoStarted.current || !canStart || !installed || !lookupDone) return
    autoStarted.current = true
    run.start(prompt, auto, asksRetranslation)
  }, [canStart, installed, lookupDone, run, prompt, auto, asksRetranslation])
  const cut = englishSent.cut || koreanSent.cut

  const copy = (key: string, text: string): void => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(key)
        setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500)
      },
      () => {},
    )
  }
  const manual = (siteUrl: string): void => {
    copy('prompt', prompt)
    window.open(siteUrl)
  }

  const use = (text: string): void => {
    const result: ReplaceResult = replaceSnapshot(
      editor,
      snapshot,
      text,
      trackChanges ? { author: authorName() } : undefined,
    )
    if (result.ok) {
      onClose()
      return
    }
    setNotice(result.reason === 'stale' ? 'cmpStale' : 'cmpCannotReplace')
  }

  const card = (
    key: string,
    title: string,
    body: React.ReactNode,
    text: string | null,
    extra?: React.ReactNode,
  ): React.JSX.Element => (
    <div className="cmp-card" key={key}>
      <div className="cmp-card-head">
        <span className="cmp-card-title">{title}</span>
        {extra}
      </div>
      <div className="cmp-card-body">{body}</div>
      {text && (
        <div className="cmp-card-foot">
          <button type="button" className="ai-ask-confirm" disabled={cut} onClick={() => use(text)}>
            {t('cmpUse')}
          </button>
          <button type="button" className="ai-ask-cancel" onClick={() => copy(key, text)}>
            {copied === key ? t('cmpCopied') : t('cmpCopy')}
          </button>
        </div>
      )}
    </div>
  )

  const statusChip = (status: EngineStatus): React.JSX.Element => (
    <span className={`cmp-chip cmp-chip-${status}`}>{t(STATUS_KEYS[status])}</span>
  )
  const integrateStatus: EngineStatus =
    state.integrate.status === 'running'
      ? 'running'
      : state.integrate.status === 'done'
        ? 'done'
        : state.integrate.status === 'failed'
          ? 'failed'
          : 'waiting'
  const anyDone = state.engines.some((e) => e.status === 'done')
  const noneAnswered =
    state.started &&
    state.engines.every((e) => e.status !== 'waiting' && e.status !== 'running') &&
    !anyDone
  const busy = state.engines.some((e) => e.status === 'running' || e.status === 'waiting')

  const manualButtons = (
    <div className="cmp-manual">
      {COMPARE_SITES.map((site) => (
        <button
          key={site.id}
          type="button"
          className="ai-ask-cancel"
          onClick={() => manual(site.url)}
        >
          {t('cmpManual', { name: site.name })}
        </button>
      ))}
    </div>
  )

  return (
    <div
      ref={rootRef}
      className="cmp-pop"
      role="dialog"
      aria-label={t('cmpTitle')}
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? 0,
        width: Math.min(WIDTH, editorBounds().width - 2 * MARGIN),
        maxHeight: editorBounds().height - 2 * MARGIN,
      }}
      // clicking the popup must not move the document selection; text fields and the result texts
      // are excepted so their text can be selected and copied (the range to replace was stored
      // when the popup opened, so a moved selection does not matter)
      onMouseDown={(e) => {
        if (!(e.target as HTMLElement).closest('textarea, input, .cmp-card-body, .cmp-text'))
          e.preventDefault()
      }}
    >
      <div
        className="cmp-title"
        onPointerDown={onTitleDown}
        onPointerMove={onTitleMove}
        onPointerUp={onTitleUp}
        onPointerCancel={onTitleUp}
      >
        <span>{t('cmpTitle')}</span>
        <button
          type="button"
          className="cmp-close"
          data-tip={t('appClose')}
          aria-label={t('appClose')}
          onClick={onClose}
        >
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" aria-hidden>
            <path
              d="M6 6l12 12M18 6L6 18"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
      <div className="cmp-body">
        <p className="cmp-note">{t('cmpLeaves', { sites: siteNames })}</p>
        {consent === false && (
          <div className="ai-ask-pop-foot">
            <button
              type="button"
              className="ai-ask-confirm"
              onClick={() => {
                setConsent(true)
                void window.desktop?.compareSetConsent?.()
              }}
            >
              {t('cmpConsentAgree')}
            </button>
          </div>
        )}
        {consent && (
          <>
            {!showOriginal ? (
              <div>
                <button type="button" className="cmp-link" onClick={() => setShowOriginal(true)}>
                  {t('cmpAddOriginal')}
                </button>
              </div>
            ) : (
              <>
                <label className="cmp-label" htmlFor="cmp-korean">
                  {t('cmpSourceLabel')}
                </label>
                {autoFilled && <div className="cmp-hint">{t('cmpSourceAuto')}</div>}
                <textarea
                  id="cmp-korean"
                  className="ai-ask-pop-input cmp-text"
                  value={korean}
                  rows={3}
                  placeholder={t('cmpSourcePlaceholder')}
                  onChange={(e) => setKorean(e.target.value)}
                />
              </>
            )}
            {cut && <div className="cmp-warn">{t('cmpCut', { max: COMPARE_TEXT_MAX_CHARS })}</div>}
            {detection === 'checking' && <div className="cmp-hint">{t('cmpChecking')}</div>}
            {detection !== 'checking' && !detection.installed && (
              <div className="cmp-missing">
                <div>{t('cmpEgoMissing')}</div>
                {missing === 'steps' && (
                  <div className="cmp-hint">{t('cmpEgoSteps', { sites: siteNames })}</div>
                )}
                <div className="ai-ask-pop-foot">
                  {missing === 'ask' || missing === 'later' ? (
                    <>
                      {missing === 'ask' && (
                        <button
                          type="button"
                          className="ai-ask-cancel"
                          onClick={() => setMissing('later')}
                        >
                          {t('cmpLater')}
                        </button>
                      )}
                      <button
                        type="button"
                        className="ai-ask-confirm"
                        onClick={() => {
                          // never downloads or runs an installer: the person installs it from that page
                          window.open(EGO_INSTALL_URL)
                          setMissing('steps')
                        }}
                      >
                        {t('cmpInstall')}
                      </button>
                    </>
                  ) : (
                    <button type="button" className="ai-ask-confirm" onClick={checkEgo}>
                      {t('cmpRecheck')}
                    </button>
                  )}
                </div>
                {manualButtons}
              </div>
            )}
            {installed && (
              <div className="cmp-actions">
                <label className="cmp-auto">
                  <input
                    type="checkbox"
                    checked={auto}
                    onChange={(e) => setAuto(e.target.checked)}
                  />
                  {t('cmpAutoIntegrate')}
                </label>
                {hasOriginal && (
                  <label className="cmp-auto cmp-retranslate">
                    <input
                      type="checkbox"
                      checked={retranslate}
                      onChange={(e) => {
                        setRetranslate(e.target.checked)
                        void window.desktop?.compareSetRetranslate?.(e.target.checked)
                      }}
                    />
                    {t('cmpRetranslate')}
                  </label>
                )}
                {busy && state.started ? (
                  <button type="button" className="ai-ask-cancel" onClick={() => run.stop()}>
                    {t('cmpStop')}
                  </button>
                ) : (
                  anyDone && (
                    <button
                      type="button"
                      className="ai-ask-cancel"
                      onClick={() => run.integrateNow()}
                    >
                      {t('cmpIntegrateNow')}
                    </button>
                  )
                )}
                <button
                  type="button"
                  className="ai-ask-confirm"
                  disabled={!canStart || (busy && state.started)}
                  onClick={() => {
                    setNotice(null)
                    run.start(prompt, auto, asksRetranslation)
                  }}
                >
                  {t('cmpStart')}
                </button>
              </div>
            )}
            {notice && <div className="cmp-warn">{t(notice)}</div>}
            {noneAnswered && (
              <div className="cmp-missing">
                <div>{t('cmpNoAnswer')}</div>
                {manualButtons}
              </div>
            )}
            <div className="cmp-cards">
              {card('original', t('cmpCardOriginal'), english, english)}
              {installed &&
                state.started &&
                state.engines.map((engine) => {
                  const site = COMPARE_SITES.find((s) => s.id === engine.id)
                  if (!site) return null
                  const retryable = ['failed', 'stopped', 'skipped', 'needsUser'].includes(
                    engine.status,
                  )
                  const both = engine.text && engine.retranslation
                  const head = (
                    <span className="cmp-head-actions">
                      {statusChip(engine.status)}
                      {retryable && (
                        <button
                          type="button"
                          className="cmp-link"
                          onClick={() => run.retry(engine.id)}
                        >
                          {t('cmpRetry')}
                        </button>
                      )}
                      {engine.status === 'failed' && (
                        <button type="button" className="cmp-link" onClick={() => manual(site.url)}>
                          {t('cmpManual', { name: site.name })}
                        </button>
                      )}
                    </span>
                  )
                  // the first card carries the status; a second one holds the re-translation
                  const first = engine.text ?? engine.retranslation ?? null
                  const firstKind = engine.text ? 'cmpKindPolished' : 'cmpKindRetranslated'
                  return (
                    <React.Fragment key={engine.id}>
                      {card(
                        engine.id,
                        engine.retranslation ? `${site.name} · ${t(firstKind)}` : site.name,
                        engine.status === 'done' ? (
                          first
                        ) : engine.status === 'needsUser' ? (
                          <span className="cmp-reason">{t('cmpNeedsUserHint')}</span>
                        ) : engine.reason ? (
                          <span className="cmp-reason">{engine.reason}</span>
                        ) : null,
                        engine.status === 'done' ? first : null,
                        head,
                      )}
                      {both &&
                        card(
                          `${engine.id}-re`,
                          `${site.name} · ${t('cmpKindRetranslated')}`,
                          engine.retranslation,
                          engine.retranslation ?? null,
                        )}
                    </React.Fragment>
                  )
                })}
              {installed &&
                state.started &&
                card(
                  'integrated',
                  t('cmpCardIntegrated'),
                  state.integrate.status === 'done' ? (
                    state.integrate.text
                  ) : state.integrate.reason ? (
                    <span className="cmp-reason">{state.integrate.reason}</span>
                  ) : null,
                  state.integrate.status === 'done' ? (state.integrate.text ?? null) : null,
                  statusChip(integrateStatus),
                )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
