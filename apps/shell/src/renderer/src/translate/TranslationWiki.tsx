import { productName } from '@genoffice/i18n'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { TranslationWikiOpenResult } from '../../../shared/translate-api'
import { useI18n } from '../locale'
import { makeText } from './shared'
import './translate-global'

const WikiContext = createContext<{ open: () => void; opening: boolean } | null>(null)

export function useTranslationWiki() {
  return useContext(WikiContext)
}

export function TranslationWikiButton({ className = 'projects-ghost' }: { className?: string }) {
  const { lang } = useI18n()
  const wiki = useTranslationWiki()
  return (
    <button
      type="button"
      className={className}
      data-action="open-translation-wiki"
      disabled={!wiki || wiki.opening}
      onClick={wiki?.open}
    >
      {makeText(lang)('wikiView')}
    </button>
  )
}

export function TranslationWikiProvider({
  homeActive,
  children,
}: {
  homeActive: boolean
  children: ReactNode
}) {
  const [result, setResult] = useState<TranslationWikiOpenResult | null>(null)
  const [opening, setOpening] = useState(false)
  const explicit = useRef(false)
  const mounted = useRef(false)
  const checkOnFocus = useRef(true)
  const home = useRef(homeActive)
  home.current = homeActive

  const show = useCallback((next: TranslationWikiOpenResult) => {
    if (next.status === 'idle') {
      checkOnFocus.current = next.pending === true
      return
    }
    checkOnFocus.current = next.status === 'setup' || next.status === 'download'
    if (next.status === 'opened') {
      setResult(null)
      return
    }
    setResult(next)
    // Native editor views cover the shell DOM. Home can display the setup guide
    // without closing the translation pair or losing its edits.
    if (!home.current) void window.aiOfficeTabs.activate('home').catch(() => {})
  }, [])

  useEffect(() => {
    mounted.current = true
    let active = true
    let resuming = false
    const resume = async () => {
      if (resuming || explicit.current || !checkOnFocus.current || !window.translateApi) return
      resuming = true
      try {
        const next = await window.translateApi.resumeWiki()
        if (active && !explicit.current) show(next)
      } catch {
        // An automatic check must not interrupt someone opening an unrelated document.
      } finally {
        resuming = false
      }
    }
    void resume()
    window.addEventListener('focus', resume)
    return () => {
      active = false
      mounted.current = false
      window.removeEventListener('focus', resume)
    }
  }, [show])

  const open = async () => {
    if (explicit.current || !window.translateApi) return
    explicit.current = true
    setOpening(true)
    try {
      const next = await window.translateApi.openWiki()
      if (mounted.current) show(next)
    } catch {
      if (mounted.current) show({ status: 'unavailable', vaultPath: '' })
    } finally {
      explicit.current = false
      if (mounted.current) setOpening(false)
    }
  }

  return (
    <WikiContext.Provider value={{ open, opening }}>
      {children}
      {homeActive && result && (
        <WikiGuide
          key={result.status + result.vaultPath}
          result={result}
          onClose={() => setResult(null)}
        />
      )}
    </WikiContext.Provider>
  )
}

function WikiGuide({
  result,
  onClose,
}: {
  result: TranslationWikiOpenResult
  onClose: () => void
}) {
  const { lang, t } = useI18n()
  const s = makeText(lang)
  const dialog = useRef<HTMLDialogElement>(null)
  const pathField = useRef<HTMLInputElement>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const node = dialog.current
    node?.showModal()
    return () => node?.close()
  }, [])

  const copy = async () => {
    try {
      if (window.aiOfficeIntegrations) await window.aiOfficeIntegrations.copyText(result.vaultPath)
      else await navigator.clipboard.writeText(result.vaultPath)
      setCopied(true)
    } catch {
      // Keep manual copying available when the system clipboard rejects the write.
      pathField.current?.focus()
      pathField.current?.select()
    }
  }

  const message =
    result.status === 'setup'
      ? 'wikiSetup'
      : result.status === 'download'
        ? 'wikiDownload'
        : 'wikiUnavailable'
  return (
    <dialog
      ref={dialog}
      className="modal translate-wiki-guide"
      aria-labelledby="translate-wiki-title"
      aria-describedby="translate-wiki-message"
      onCancel={onClose}
    >
      <h3 id="translate-wiki-title">{s('wikiView')}</h3>
      <p id="translate-wiki-message">{s(message, { app: productName(lang) })}</p>
      {result.vaultPath && result.status !== 'download' && (
        <label className="projects-field">
          <span>{s('wikiFolder')}</span>
          <input
            ref={pathField}
            value={result.vaultPath}
            readOnly
            dir="auto"
            onFocus={(e) => e.currentTarget.select()}
          />
        </label>
      )}
      <div className="modal-buttons">
        {result.vaultPath && result.status !== 'download' && (
          <button type="button" className="btn btn-secondary" onClick={() => void copy()}>
            {copied ? t('setMcpCopied') : t('copyPath')}
          </button>
        )}
        <button type="button" className="btn btn-primary" autoFocus onClick={onClose}>
          {s('dismissNotice')}
        </button>
      </div>
    </dialog>
  )
}
