/**
 * The "AI compare" popup: asks Copilot through ego lite and the app’s current connected AI about the selected text or about the whole
 * document, one unit (paragraph) at a time with its enabled AIs in parallel, and lists every answer as a card
 * the person can apply to the document.
 *
 * It is an in-page floating panel, movable by its title bar and clamped to the editor area. It
 * never takes the document selection. Every unit keeps the range and text fingerprint it was
 * asked about (carried through edits), and applying a card replaces exactly that paragraph text,
 * refused when the text under the range changed.
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
import type { Node as PmNodeType } from '@tiptap/pm/model'
import { aiSendGate, AiInputTruncatedNotice } from '@genoffice/ui'
import { createElectronTransport } from '../ai/transport'
import { integrateComparison } from '../compare/integration'
import { createConnectedCompareAsk } from '../compare/connected-ai'
import { CONNECTED_AI_ENGINE_ID } from '../../shared/compare-engines'
import type { AiSettings } from '@genoffice/ai-provider/browser'
import { useI18n, type StringKey } from '../i18n/locale'
import { setInactiveSelectionShown } from '../editor/inactive-selection'
import { COMPARE_SITES, EGO_INSTALL_URL } from '../../shared/compare-sites'
import type {
  CompareAnswer,
  CompareDriverClient,
  ComparePrefs,
  EgoDetection,
} from '../../shared/compare'
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
import {
  COMPARE_BATCH_SIZE,
  createRunner,
  type EngineStatus,
  type RunnerUnit,
  type UnitResult,
} from '../compare/runner'
import { rangeText, replaceSnapshot, type SelectionSnapshot } from '../compare/replace-selection'
import { loadSourceDoc, sourceTextFor } from '../compare/source-locate'
import {
  enumerateUnits,
  mapRange,
  enumerateSelectionUnits,
  type LiveRange,
  type TextUnit,
} from '../compare/units'

interface Props {
  editor: Editor
  /** the selection the popup was opened on, or null (then the whole document is the scope) */
  snapshot: SelectionSnapshot | null
  settings: AiSettings
  /** the tracked-changes toggle: a replacement is then recorded as a revision */
  trackChanges: boolean
  onClose: () => void
}

type Scope = 'selection' | 'document'

const WIDTH = 600
const MARGIN = 8

const siteNames = COMPARE_SITES.map((site) => site.name).join(', ')

const STATUS_KEYS: Record<EngineStatus, StringKey> = {
  waiting: 'cmpStWaiting',
  running: 'cmpStRunning',
  done: 'cmpStDone',
  failed: 'cmpStFailed',
  stopped: 'cmpStStopped',
  blocked: 'cmpStBlocked',
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

/** what the popup remembers about one unit while a run goes on */
interface UnitInfo extends LiveRange {
  /** the text asked about, as the document held it (the stale-text fingerprint) */
  fingerprint: string
  /** the text as shown on the original card */
  shown: string
  hasObjects: boolean
  /** the text sent was cut: using a result would drop the rest */
  cut: boolean
  korean: string
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
  const [consent, setConsent] = useState<boolean | null>(null)
  const [detection, setDetection] = useState<EgoDetection | 'checking'>('checking')
  const [missing, setMissing] = useState<MissingStep>('ask')
  const [scope, setScope] = useState<Scope>(snapshot ? 'selection' : 'document')
  const [prefs, setPrefs] = useState<ComparePrefs>({})
  const [typedOriginal, setTypedOriginal] = useState('')
  const [showOriginal, setShowOriginal] = useState(false)
  const [targetCode, setTargetCode] = useState<string | null>(null)
  const sourceDoc = useRef<PmNodeType | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [notice, setNotice] = useState<StringKey | null>(null)
  const [inputTruncated, setInputTruncated] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  const engineOn = (id: string): boolean => prefs.engines?.[id] !== false
  const retranslate = prefs.retranslate !== false
  const engineOptions = [
    ...COMPARE_SITES.map((s) => ({ id: s.id, name: s.name })),
    { id: CONNECTED_AI_ENGINE_ID, name: t('cmpConnectedAi') },
  ]
  const engineName = (id: string): string => engineOptions.find((s) => s.id === id)?.name ?? id
  const enabledEngines = engineOptions.filter((s) => engineOn(s.id)).map((s) => s.id)
  const connectedSelected = enabledEngines.includes(CONNECTED_AI_ENGINE_ID)
  const autoIntegrate = prefs.autoIntegrate === true && !connectedSelected
  const needsWeb = COMPARE_SITES.some((site) => enabledEngines.includes(site.id))
  const savePrefs = (patch: ComparePrefs): void => {
    setPrefs((p) => ({ ...p, ...patch, engines: { ...p.engines, ...patch.engines } }))
    void window.desktop?.compareSetPrefs?.(patch)?.catch(() => {})
  }

  const targetName = languageName(targetCode ?? lang)
  const runOptions = useRef({ retranslate, target: targetName })
  // latest values for the long-lived runner (its prompt and integration steps read them when they run)
  const live = useRef({
    settings,
    statuses: subscription.statuses,
    target: targetName,
    retranslate,
  })
  live.current = {
    settings,
    statuses: subscription.statuses,
    target: targetName,
    retranslate,
  }
  /** the ranges and fingerprints of the units of the current run, carried through edits */
  const infos = useRef(new Map<string, UnitInfo>())
  const selectionRange = useRef(snapshot ? { ...snapshot, gone: false } : null)

  const webDriver = useMemo(ipcDriver, [])
  const connectedAsk = useMemo(
    () =>
      createConnectedCompareAsk({
        getSettings: async () => (await window.desktop?.getAiSettings?.()) ?? live.current.settings,
        getStatuses: () => live.current.statuses,
        transportFor: (current) =>
          createElectronTransport(() => current, {
            onInputTruncated: () => setInputTruncated(true),
          }),
        unavailableText: () => t('cmpConnectedUnavailable'),
      }),
    // The long-lived client reads current settings/statuses for each unit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  const driver = useMemo<CompareDriverClient>(
    () => ({
      detect: webDriver.detect,
      ask: (id, prompt, signal) =>
        id === CONNECTED_AI_ENGINE_ID
          ? connectedAsk(prompt, signal)
          : webDriver.ask(id, prompt, signal),
    }),
    [webDriver, connectedAsk],
  )
  const runner = useMemo(
    () =>
      createRunner({
        driver,
        promptFor: (unit) =>
          buildComparePrompt(unit.korean, unit.text, {
            retranslate: runOptions.current.retranslate && unit.korean !== '',
            targetLanguage: runOptions.current.target,
          }),
        retranslateFor: (unit) => runOptions.current.retranslate && unit.korean !== '',
        integrate: async (unit, answers, signal): Promise<CompareAnswer> => {
          const { settings: s, statuses } = live.current
          const { target } = runOptions.current
          // the app's own AI only, and only when its send gate lets a run through
          if (
            aiSendGate(s, statuses).kind !== 'run' ||
            !window.desktop?.aiStream ||
            !window.desktop?.onAiStream
          )
            return { ok: false, reason: t('cmpBlocked') }
          const request = buildIntegrationRequest({
            korean: unit.korean,
            original: unit.text,
            ...(unit.korean === '' ? { targetLanguage: target } : {}),
            answers: answers.map((a) => ({
              label: `${a.id === CONNECTED_AI_ENGINE_ID ? t('cmpConnectedAi') : (COMPARE_SITES.find((site) => site.id === a.id)?.name ?? a.id)} (${a.kind === 'polished' ? 'polished' : 're-translated'})`,
              text: a.text,
            })),
          })
          const transport = createElectronTransport(() => s, {
            onInputTruncated: () => setInputTruncated(true),
          })
          return integrateComparison(transport, request, signal)
        },
      }),
    // `t` is deliberately not a dependency: the runner is created once per popup
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [driver],
  )
  const state = useSyncExternalStore(runner.subscribe, runner.getState)
  useEffect(
    () => () => {
      runner.stop()
    },
    [runner],
  )
  useEffect(() => runner.setAutoIntegrate(autoIntegrate), [runner, autoIntegrate])

  // every edit moves the ranges of the units
  useEffect(() => {
    const onTransaction = ({
      transaction,
    }: {
      transaction: { docChanged: boolean; mapping: Parameters<typeof mapRange>[1] }
    }): void => {
      if (!transaction.docChanged) return
      if (selectionRange.current)
        selectionRange.current = {
          ...selectionRange.current,
          ...mapRange(selectionRange.current, transaction.mapping),
        }
      for (const [id, info] of infos.current)
        infos.current.set(id, { ...info, ...mapRange(info, transaction.mapping) })
    }
    editor.on('transaction', onTransaction)
    return () => {
      editor.off('transaction', onTransaction)
    }
  }, [editor])

  const checkEgo = useCallback(() => {
    setDetection('checking')
    void driver.detect().then(
      (found) => setDetection(found),
      () => setDetection({ installed: false }),
    )
  }, [driver])

  useEffect(() => {
    let alive = true
    void Promise.resolve(window.desktop?.compareGetPrefs?.())
      .then((p) => alive && p && setPrefs(p))
      .catch(() => {})
    void Promise.resolve(window.desktop?.compareGetConsent?.())
      .then((v) => alive && setConsent(v === true))
      .catch(() => alive && setConsent(false))
    checkEgo()
    // best effort and silent: the target language of the translation project and its source copy
    // (the Korean original of a paragraph is found by block position)
    void Promise.resolve(window.desktop?.getTranslationLanguages?.())
      .then((pair) => alive && pair?.targetLang && setTargetCode(pair.targetLang))
      .catch(() => {})
    void loadSourceDoc(editor, window.desktop?.compareReadSource).then((doc) => {
      if (alive) sourceDoc.current = doc
    })
    return () => {
      alive = false
    }
  }, [editor, checkEgo])

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
  }, [state, detection, consent, missing, expanded])
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

  const installed = detection !== 'checking' && detection.installed
  const running = state.phase === 'running'
  const active = running || state.phase === 'paused'

  /** the units of the chosen scope, with the Korean original of each when the project has one */
  const buildUnits = (): { runner: RunnerUnit[]; infos: Map<string, UnitInfo> } => {
    const raw: TextUnit[] =
      scope === 'selection' && selectionRange.current
        ? enumerateSelectionUnits(editor.state.doc, selectionRange.current)
        : enumerateUnits(editor.state.doc)
    const out: RunnerUnit[] = []
    const map = new Map<string, UnitInfo>()
    for (const unit of raw) {
      const sent = capText(unit.text)
      if (sent.text === '') continue
      let korean = ''
      if (scope === 'selection' && raw.length === 1 && typedOriginal.trim() !== '')
        korean = typedOriginal
      else if (
        sourceDoc.current &&
        editor.state.doc.resolve(unit.from).parentOffset === 0 &&
        editor.state.doc.resolve(unit.to).parentOffset ===
          editor.state.doc.resolve(unit.to).parent.content.size
      )
        korean = sourceTextFor(editor.state.doc, sourceDoc.current, unit.from, unit.to) ?? ''
      const koreanSent = capText(korean)
      out.push({ id: unit.id, text: sent.text, korean: koreanSent.text })
      map.set(unit.id, {
        from: unit.from,
        to: unit.to,
        gone: false,
        fingerprint: unit.text,
        shown: unit.text,
        hasObjects: unit.hasObjects,
        cut: sent.cut || koreanSent.cut,
        korean: koreanSent.text,
      })
    }
    return { runner: out, infos: map }
  }

  const start = (): void => {
    setNotice(null)
    setInputTruncated(false)
    const selection = selectionRange.current
    if (
      scope === 'selection' &&
      selection &&
      (selection.gone || rangeText(editor, selection.from, selection.to) !== selection.fingerprint)
    ) {
      setNotice('cmpStale')
      return
    }
    const built = buildUnits()
    if (built.runner.length === 0) {
      setNotice('cmpNoUnits')
      return
    }
    runOptions.current = { retranslate, target: targetName }
    infos.current = built.infos
    setExpanded(new Set(scope === 'selection' ? [built.runner[0]!.id] : []))
    runner.start(built.runner, enabledEngines, autoIntegrate)
  }

  const copy = (key: string, text: string): void => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(key)
        setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500)
      },
      () => {},
    )
  }
  const manual = (siteUrl: string, unitId?: string): void => {
    const info = unitId ? infos.current.get(unitId) : buildUnits().infos.values().next().value
    const text = info ? capText(info.shown).text : ''
    copy(
      'prompt',
      buildComparePrompt(info?.korean ?? '', text, {
        retranslate: retranslate && !!info?.korean,
        targetLanguage: targetName,
      }),
    )
    window.open(siteUrl)
  }

  /** replace one unit's text; false when it was refused (the notice says why) */
  const applyUnit = (unitId: string, text: string): boolean => {
    const info = infos.current.get(unitId)
    if (!info || info.gone || info.hasObjects || info.cut) {
      setNotice('cmpCannotReplace')
      return false
    }
    const result = replaceSnapshot(
      editor,
      { from: info.from, to: info.to, fingerprint: info.fingerprint },
      text,
      trackChanges ? { author: authorName() } : undefined,
    )
    if (!result.ok) {
      setNotice(result.reason === 'stale' ? 'cmpStale' : 'cmpCannotReplace')
      return false
    }
    runner.markApplied(unitId)
    return true
  }

  const toggle = (id: string): void =>
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const card = (
    unitId: string,
    key: string,
    title: string,
    body: React.ReactNode,
    text: string | null,
    applied: boolean,
    extra?: React.ReactNode,
  ): React.JSX.Element => {
    const info = infos.current.get(unitId)
    return (
      <div className="cmp-card" key={key}>
        <div className="cmp-card-head">
          <span className="cmp-card-title">{title}</span>
          {extra}
        </div>
        <div className="cmp-card-body">{body}</div>
        {text && (
          <div className="cmp-card-foot">
            <button
              type="button"
              className="ai-ask-confirm"
              disabled={applied || !!info?.cut || !!info?.hasObjects}
              onClick={() => applyUnit(unitId, text)}
            >
              {t('cmpUse')}
            </button>
            <button
              type="button"
              className="ai-ask-cancel"
              onClick={() => copy(`${unitId}-${key}`, text)}
            >
              {copied === `${unitId}-${key}` ? t('cmpCopied') : t('cmpCopy')}
            </button>
          </div>
        )}
      </div>
    )
  }

  const chip = (status: EngineStatus, label?: string): React.JSX.Element => (
    <span className={`cmp-chip cmp-chip-${status}`}>
      {label ? `${label}: ` : ''}
      {t(STATUS_KEYS[status])}
    </span>
  )

  const unitRow = (result: UnitResult, index: number): React.JSX.Element => {
    const info = infos.current.get(result.id)
    const open = expanded.has(result.id)
    const idle = !active && state.phase !== 'running'
    return (
      <div className="cmp-unit" key={result.id}>
        <div
          className="cmp-unit-row"
          role="button"
          tabIndex={0}
          aria-expanded={open}
          onClick={() => toggle(result.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              toggle(result.id)
            }
          }}
        >
          <span className="cmp-unit-arrow">{open ? '▾' : '▸'}</span>
          <span className="cmp-unit-n">{index + 1}</span>
          <span className="cmp-unit-text">{(info?.shown ?? '').slice(0, 60)}</span>
          <span className="cmp-unit-chips">
            {state.engines.map((id) => {
              const e = result.engines[id]
              const name = engineName(id)
              return e ? <React.Fragment key={id}>{chip(e.status, name)}</React.Fragment> : null
            })}
            {result.applied && <span className="cmp-chip cmp-chip-done">{t('cmpApplied')}</span>}
          </span>
        </div>
        {open && (
          <div className="cmp-cards">
            {!info?.korean && <div className="cmp-hint">{t('cmpNoSource')}</div>}
            {info?.cut && (
              <div className="cmp-warn">{t('cmpCut', { max: COMPARE_TEXT_MAX_CHARS })}</div>
            )}
            {card(
              result.id,
              'original',
              t('cmpCardOriginal'),
              info?.shown ?? '',
              info?.shown ?? null,
              true,
            )}
            {state.engines.map((id) => {
              const site = COMPARE_SITES.find((s) => s.id === id)
              const engine = engineOptions.find((s) => s.id === id)
              const e = result.engines[id]
              if (!engine || !e) return null
              const retry = idle && (e.status === 'failed' || e.status === 'stopped')
              const head = (
                <span className="cmp-head-actions">
                  {chip(e.status)}
                  {retry && (
                    <button
                      type="button"
                      className="cmp-link"
                      onClick={() => runner.retry(result.id, id)}
                    >
                      {t('cmpRetry')}
                    </button>
                  )}
                  {site && (
                    <button
                      type="button"
                      className="cmp-link"
                      onClick={() => manual(site.url, result.id)}
                    >
                      {t('cmpManual', { name: site.name })}
                    </button>
                  )}
                </span>
              )
              const first = e.text ?? e.retranslation ?? null
              const firstKind = e.text ? 'cmpKindPolished' : 'cmpKindRetranslated'
              const both = e.text && e.retranslation
              return (
                <React.Fragment key={id}>
                  {card(
                    result.id,
                    id,
                    e.retranslation ? `${engine.name} · ${t(firstKind)}` : engine.name,
                    e.status === 'done' ? (
                      first
                    ) : e.status === 'blocked' ? (
                      <span className="cmp-reason">{blockText(e.reason ?? '')}</span>
                    ) : e.reason ? (
                      <span className="cmp-reason">{interactionText(e.reason)}</span>
                    ) : null,
                    e.status === 'done' ? first : null,
                    result.applied,
                    head,
                  )}
                  {both &&
                    card(
                      result.id,
                      `${id}-re`,
                      `${engine.name} · ${t('cmpKindRetranslated')}`,
                      e.retranslation,
                      e.retranslation ?? null,
                      result.applied,
                    )}
                </React.Fragment>
              )
            })}
            {(result.integrate.status !== 'idle' || result.engines) &&
              card(
                result.id,
                'integrated',
                t('cmpCardIntegrated'),
                result.integrate.status === 'done' ? (
                  result.integrate.text
                ) : result.integrate.reason ? (
                  <span className="cmp-reason">{result.integrate.reason}</span>
                ) : null,
                result.integrate.status === 'done' ? (result.integrate.text ?? null) : null,
                result.applied,
                <span className="cmp-head-actions">
                  {result.integrate.status === 'running'
                    ? chip('running')
                    : result.integrate.status === 'done'
                      ? chip('done')
                      : result.integrate.status === 'failed'
                        ? chip('failed')
                        : null}
                  {idle &&
                    result.integrate.status !== 'running' &&
                    Object.values(result.engines).some((e) => e.status === 'done') && (
                      <button
                        type="button"
                        className="cmp-link"
                        onClick={() => runner.integrateNow(result.id)}
                      >
                        {t('cmpIntegrateNow')}
                      </button>
                    )}
                </span>,
              )}
          </div>
        )}
      </div>
    )
  }

  const manualButtons = (
    <div className="cmp-manual">
      {COMPARE_SITES.map((site) => (
        <button
          key={site.id}
          type="button"
          className="ai-ask-cancel"
          onClick={() => manual(site.url, state.units[0]?.id)}
        >
          {t('cmpManual', { name: site.name })}
        </button>
      ))}
    </div>
  )

  const done = Math.max(0, Math.min(state.next, state.batchEnd) - state.batchStart)
  const batchTotal = state.batchEnd - state.batchStart
  const blockedList = Object.entries(state.blocked)
  const blockText = (reason: string): string =>
    t(
      reason === 'login-wall'
        ? 'cmpStSkipped'
        : reason === 'needs-user'
          ? 'cmpStNeedsUser'
          : 'cmpStBlocked',
    )
  const interactionText = (reason: string): string => {
    if (reason === 'no-prompt-box') return t('cmpInputMissing')
    if (reason === 'input-not-accepted') return t('cmpInputFailed')
    if (reason === 'submit-not-ready') return t('cmpSendUnavailable')
    return reason
  }
  const started = state.phase !== 'idle'
  const canStart =
    consent === true && (!needsWeb || installed) && enabledEngines.length > 0 && !active

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
      // are excepted so their text can be selected and copied (the ranges to replace were stored
      // when the run started, so a moved selection does not matter)
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
                void window.desktop?.compareSetConsent?.()?.catch(() => {})
              }}
            >
              {t('cmpConsentAgree')}
            </button>
          </div>
        )}
        {consent && (
          <>
            {needsWeb && detection === 'checking' && (
              <div className="cmp-hint">{t('cmpChecking')}</div>
            )}
            {needsWeb && detection !== 'checking' && !detection.installed && (
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
            <div className="cmp-controls">
              <div className="cmp-switches" role="group">
                {engineOptions.map((site) => (
                  <label key={site.id} className="cmp-auto">
                    <input
                      type="checkbox"
                      role="switch"
                      checked={engineOn(site.id)}
                      disabled={active || state.phase === 'batchDone'}
                      onChange={(e) => savePrefs({ engines: { [site.id]: e.target.checked } })}
                    />
                    {site.name}
                  </label>
                ))}
              </div>
              <div className="cmp-scope" role="radiogroup">
                <label className="cmp-auto">
                  <input
                    type="radio"
                    name="cmp-scope"
                    checked={scope === 'selection'}
                    disabled={!snapshot || active || state.phase === 'batchDone'}
                    onChange={() => setScope('selection')}
                  />
                  {t('cmpScopeSelection')}
                </label>
                <label className="cmp-auto">
                  <input
                    type="radio"
                    name="cmp-scope"
                    checked={scope === 'document'}
                    disabled={active || state.phase === 'batchDone'}
                    onChange={() => setScope('document')}
                  />
                  {t('cmpScopeDocument')}
                </label>
              </div>
              <div className="cmp-actions">
                <label className="cmp-auto">
                  <input
                    type="checkbox"
                    checked={autoIntegrate}
                    disabled={connectedSelected}
                    onChange={(e) => savePrefs({ autoIntegrate: e.target.checked })}
                  />
                  {t('cmpAutoIntegrate')}
                </label>
                <label className="cmp-auto cmp-retranslate">
                  <input
                    type="checkbox"
                    checked={retranslate}
                    disabled={active || state.phase === 'batchDone'}
                    onChange={(e) => savePrefs({ retranslate: e.target.checked })}
                  />
                  {t('cmpRetranslate')}
                </label>
                {active ? (
                  <>
                    <button
                      type="button"
                      className="ai-ask-cancel"
                      onClick={() => (running ? runner.pause() : runner.resume())}
                    >
                      {t(running ? 'cmpPause' : 'cmpResume')}
                    </button>
                    <button type="button" className="ai-ask-cancel" onClick={() => runner.stop()}>
                      {t('cmpStop')}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="ai-ask-confirm"
                    disabled={!canStart}
                    onClick={start}
                  >
                    {t('cmpStart')}
                  </button>
                )}
              </div>
              {enabledEngines.length === 0 && <div className="cmp-hint">{t('cmpNoEngine')}</div>}
              {scope === 'selection' &&
                snapshot &&
                selectionRange.current &&
                !selectionRange.current.gone &&
                editor.state.doc
                  .resolve(selectionRange.current.from)
                  .sameParent(editor.state.doc.resolve(selectionRange.current.to)) && (
                  <div>
                    {!showOriginal ? (
                      <button
                        type="button"
                        className="cmp-link"
                        onClick={() => setShowOriginal(true)}
                      >
                        {t('cmpAddOriginal')}
                      </button>
                    ) : (
                      <>
                        <label className="cmp-label" htmlFor="cmp-korean">
                          {t('cmpSourceLabel')}
                        </label>
                        <textarea
                          id="cmp-korean"
                          className="ai-ask-pop-input cmp-text"
                          value={typedOriginal}
                          rows={3}
                          disabled={active}
                          placeholder={t('cmpSourcePlaceholder')}
                          onChange={(e) => setTypedOriginal(e.target.value)}
                        />
                      </>
                    )}
                  </div>
                )}
            </div>
            {connectedSelected && <div className="cmp-hint">{t('cmpIntegrationSeparate')}</div>}
            {started && (
              <div className="cmp-progress" role="status">
                <span>{t('cmpProgress', { done, total: batchTotal })}</span>
                {state.total > state.batchEnd && (
                  <span className="cmp-hint">
                    {t('cmpRemaining', { n: state.total - state.batchEnd })}
                  </span>
                )}
                {state.phase === 'batchDone' && (
                  <button
                    type="button"
                    className="ai-ask-confirm"
                    onClick={() => runner.continueNext()}
                  >
                    {t('cmpContinue', {
                      n: Math.min(COMPARE_BATCH_SIZE, state.total - state.batchEnd),
                    })}
                  </button>
                )}
              </div>
            )}
            {blockedList.map(([id]) => (
              <div className="cmp-warn" key={id}>
                {t('cmpBlockedLine', {
                  name: COMPARE_SITES.find((s) => s.id === id)?.name ?? id,
                  reason: blockText(state.blocked[id] ?? ''),
                })}
              </div>
            ))}
            {state.phase === 'allBlocked' && (
              <div className="cmp-missing">
                <div>{t('cmpAllBlocked')}</div>
                {manualButtons}
              </div>
            )}
            {started && <div className="cmp-hint">{t('cmpFlatNote')}</div>}
            {notice && <div className="cmp-warn">{t(notice)}</div>}
            {inputTruncated && (
              <AiInputTruncatedNotice lang={lang} onDismiss={() => setInputTruncated(false)} />
            )}
            <div className="cmp-units">{state.units.map((u, i) => unitRow(u, i))}</div>
          </>
        )}
      </div>
    </div>
  )
}
