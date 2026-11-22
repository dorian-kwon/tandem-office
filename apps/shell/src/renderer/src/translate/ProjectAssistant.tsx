import { useEffect, useId, useRef, useState } from 'react'
import sendEnterOn from '../assets/send-enter-on.png'
import sendEnterOff from '../assets/send-enter-off.png'
import sendStop from '../assets/send-stop.png'
import { AgentLoop, createIpcTransport } from '@genoffice/agent-core'
import {
  localContextLimit,
  localModelCapabilities,
  type AiSettings,
} from '@genoffice/ai-provider/browser'
import {
  AiComposer,
  AiMark,
  AiConnectPrompt,
  AiToolsUnsupportedNotice,
  AiTypingIndicator,
  Markdown,
  aiContextConfirmText,
  aiRunErrorText,
} from '@genoffice/ui'
import { useI18n } from '../locale'
import { kbAskProjectText } from '../kb-ask-project-strings'
import type { SubscriptionConnection } from '../subscription-client'
import { isWikiEditingRequest, wikiChatLabels } from '../../../shared/wiki-chat'
import { makeText } from './shared'
import { pdfJobRoute, pdfRouteRefusal, type PdfJobRoute } from './pdf-route'
import { translationProjectSkill, type ProjectAssistantActions } from './project-assistant-skill'

export interface ProjectAssistantProps {
  aiSettings: AiSettings | null
  connection: SubscriptionConnection
  onNoticeNeeded(): void
  onOpenAiSettings(): void
  actions: ProjectAssistantActions
}

type Message = { role: 'user' | 'assistant'; text: string }

/** A chat belongs to a single translation project. Editor work runs through that editor's own AI. */
export function ProjectAssistant(props: ProjectAssistantProps) {
  const { lang, t } = useI18n()
  const [expanded, setExpanded] = useState(true)
  const bodyId = useId()
  const [draft, setDraft] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [busy, setBusy] = useState(false)
  const [askWiki, setAskWiki] = useState(false)
  const wikiForTurn = useRef<boolean | undefined>(undefined)
  const [waiting, setWaiting] = useState(false)
  const [showConnection, setShowConnection] = useState(false)
  const loop = useRef<AgentLoop | null>(null)
  const thread = useRef<HTMLDivElement>(null)
  const latest = useRef({ props, lang, t })
  latest.current = { props, lang, t }
  const pinned = useRef<Extract<PdfJobRoute, { state: 'ready' }> | null>(null)
  const route = pdfJobRoute(props.aiSettings, props.connection.statuses)

  useEffect(() => {
    let mounted = true
    function result(text: string) {
      if (mounted) setMessages((prev) => [...prev.slice(0, -1), { role: 'assistant', text }])
    }
    function finish() {
      pinned.current = null
      wikiForTurn.current = undefined
      if (mounted) setBusy(false)
    }
    const actions = () => latest.current.props.actions
    const skill = translationProjectSkill({
      api: actions().api,
      dir: actions().dir,
      project: () => actions().project(),
      useWiki: () => wikiForTurn.current,
      open: (file) => actions().open(file),
      refresh: () => actions().refresh(),
      wiki: () => actions().wiki(),
      ocr: (file) => actions().ocr(file),
      confirmRemove: (file) => actions().confirmRemove(file),
    })
    const transport = createIpcTransport<AiSettings>({
      onStream: (listener) => window.aiOffice.onAiStream(listener),
      start: (request) => {
        const current = latest.current.props
        const refusal =
          pinned.current &&
          pdfRouteRefusal(pinned.current, current.aiSettings, current.connection.statuses)
        if (!pinned.current || refusal)
          return Promise.reject(new Error(latest.current.t('askUnknownError')))
        return window.aiOffice.aiStream(request)
      },
      cancel: (id) => void window.aiOffice.aiStreamCancel(id, 'request'),
      getSettings: () => pinned.current!.settings,
      unknownErrorText: () => latest.current.t('askUnknownError'),
      errorText: (cause) => aiRunErrorText(latest.current.lang, cause),
      contextLimit: localContextLimit,
      confirmContext: (warning) =>
        window.confirm(aiContextConfirmText(latest.current.lang, warning)),
    })
    const agent = new AgentLoop({
      transport,
      skill,
      toolsAllowed: () =>
        !!pinned.current && localModelCapabilities(pinned.current.settings).tools !== false,
      events: {
        onText: result,
        onError: (text) => {
          result(text)
          finish()
        },
        onDone: ({ text, cancelled }) => {
          if (text && !cancelled) result(text)
          finish()
        },
      },
    })
    loop.current = agent
    return () => {
      mounted = false
      agent.cancel()
      loop.current = null
    }
  }, [])

  useEffect(() => {
    if (expanded && thread.current) thread.current.scrollTop = thread.current.scrollHeight
  }, [expanded, messages])

  async function send(useWiki?: boolean) {
    const instruction = draft.trim()
    const agent = loop.current
    if (!instruction || pinned.current || !agent) return
    if (route.state !== 'ready') {
      setWaiting(route.state === 'checking')
      if (route.state === 'notice') props.onNoticeNeeded()
      if (route.state === 'connect') {
        setShowConnection(true)
        props.connection.refresh()
      }
      return
    }
    const project = props.actions.project()
    const canUse = project.useWiki !== false && isWikiEditingRequest(instruction)
    if (canUse && useWiki === undefined) {
      setAskWiki(true)
      return
    }
    wikiForTurn.current = canUse && useWiki === true
    setAskWiki(false)
    setWaiting(false)
    setShowConnection(false)
    setBusy(true)
    setDraft('')
    setMessages((prev) => [
      ...prev,
      { role: 'user', text: instruction },
      { role: 'assistant', text: '' },
    ])
    pinned.current = route
    try {
      await agent.run(instruction)
    } catch (error) {
      if (loop.current === agent) {
        pinned.current = null
        wikiForTurn.current = undefined
        setBusy(false)
        setMessages((prev) => [
          ...prev.slice(0, -1),
          {
            role: 'assistant',
            text: error instanceof Error ? error.message : t('askUnknownError'),
          },
        ])
      }
    }
  }
  useEffect(() => {
    if (!waiting || route.state === 'checking') return
    setWaiting(false)
    void send()
    // A held send is retried once when the subscription check finishes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, route.state])

  const placeholder = kbAskProjectText(lang, 'askProjectPlaceholder', {
    name: props.actions.project().name,
  })
  const toggleLabel = makeText(lang)(expanded ? 'closeProjectAi' : 'openProjectAi')
  return (
    <aside
      className="kb-ask translation-project-assistant"
      data-collapsed={!expanded}
      data-testid="project-assistant"
      aria-label={kbAskProjectText(lang, 'askProjectTitle', { name: props.actions.project().name })}
    >
      <div className="kb-ask-headbar">
        {expanded && <b>AI</b>}
        <button
          type="button"
          className="project-assistant-toggle"
          title={toggleLabel}
          aria-label={toggleLabel}
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <span aria-hidden="true">×</span> : <AiMark size={22} />}
        </button>
      </div>
      <div id={bodyId} className="project-assistant-body" hidden={!expanded}>
        <div className="kb-ask-thread" ref={thread} role="log">
          {messages.map((msg, i) => (
            <div key={i} className={'kb-ask-msg kb-ask-' + msg.role}>
              {msg.role === 'user' ? (
                msg.text
              ) : msg.text ? (
                <Markdown text={msg.text} />
              ) : busy && i === messages.length - 1 ? (
                <AiTypingIndicator label={t('askHintBusy')} />
              ) : null}
            </div>
          ))}
        </div>
        {askWiki && (
          <div className="projects-note" role="group" aria-label={wikiChatLabels[lang][0]}>
            <span>{wikiChatLabels[lang][0]}</span>
            <button type="button" className="projects-primary" onClick={() => void send(true)}>
              {wikiChatLabels[lang][1]}
            </button>
            <button type="button" className="projects-ghost" onClick={() => void send(false)}>
              {wikiChatLabels[lang][2]}
            </button>
          </div>
        )}
        {waiting && (
          <p role="status" className="projects-hint">
            {makeText(lang)('trChecking')}
          </p>
        )}
        {route.state === 'connect' && showConnection && (
          <AiConnectPrompt
            choice={route.choice}
            statuses={props.connection.statuses}
            lang={lang}
            disabled={props.connection.busy}
            onInstall={props.connection.install}
            onUpdate={props.connection.update}
            onCancelLogin={props.connection.cancelLogin}
            onLogin={props.connection.login}
            onRecheck={props.connection.recheck}
            onAcceptMetered={(id) => void props.connection.acceptMetered(id)}
            onOpenInstallHelp={props.connection.openInstallHelp}
            onOpenConnectHelp={props.connection.openConnectHelp}
            onOpenSettings={props.onOpenAiSettings}
          />
        )}
        {props.aiSettings && localModelCapabilities(props.aiSettings).tools === false && (
          <AiToolsUnsupportedNotice lang={lang} />
        )}
        <AiComposer
          value={draft}
          busy={busy}
          placeholder={placeholder}
          ariaLabel={placeholder}
          hintIdle={t('askHintIdle')}
          hintBusy={t('askHintBusy')}
          sendLabel={t('askSend')}
          stopLabel={t('askStop')}
          iconOnly
          sendIconEnabled={<img src={sendEnterOn} alt="" aria-hidden />}
          sendIconDisabled={<img src={sendEnterOff} alt="" aria-hidden />}
          stopIcon={<img src={sendStop} alt="" aria-hidden />}
          onChange={(value) => {
            setAskWiki(false)
            setDraft(value)
          }}
          onSend={() => void send()}
          onStop={() => loop.current?.cancel()}
        />
      </div>
    </aside>
  )
}
