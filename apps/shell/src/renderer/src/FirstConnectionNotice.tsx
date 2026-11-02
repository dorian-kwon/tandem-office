import { useCallback, useEffect, useState } from 'react'
import {
  AiFirstConnectionNotice,
  aiSubscriptionText,
  useModalKeys,
  withAiSubscriptionNoticeSeen,
} from '@genoffice/ui'
import type { AiSettings, AiSubscriptionStatuses } from '@genoffice/ai-provider/browser'
import { useI18n } from './locale'
import { CODEX_MAY_KEEP_HISTORY, changeAiSettings, readAiSettings } from './settings-ai'
import { firstConnectionNoticeDue } from './subscription-status'

// ── First-connection notice ──────────────────────────────
// Shown once, when a subscription provider can first be used: on the connect
// step of the onboarding, in Settings, and on the home screen's ask panel. It
// says what leaves the PC and who decides how it is used. Acknowledging it
// stores `subscriptionNoticeSeen`, which the editors' AI panels read too, so
// nobody is told twice. It can be read again from Settings → AI.

export interface FirstConnectionNoticeState {
  /** the AI settings as last read; null until the first read answers (or when it cannot) */
  readonly settings: AiSettings | null
  /** a subscription provider can be used and the notice has not been acknowledged */
  readonly due: boolean
  /** record that the notice was seen */
  readonly acknowledge: () => void
}

/** The AI settings, kept current, and whether the notice is due for these statuses */
export function useFirstConnectionNotice(
  statuses: AiSubscriptionStatuses,
): FirstConnectionNoticeState {
  const [settings, setSettings] = useState<AiSettings | null>(null)
  // closes the notice at once; the stored flag keeps it away from then on
  const [acknowledged, setAcknowledged] = useState(false)

  useEffect(() => {
    let alive = true
    const load = () => {
      void readAiSettings().then((next) => {
        if (alive && next) setSettings(next)
      })
    }
    load()
    // an editor's AI panel acknowledges the same notice in the same file
    const off = window.aiOffice.onAiSettingsChanged?.(load)
    return () => {
      alive = false
      off?.()
    }
  }, [])

  const acknowledge = useCallback(() => {
    setAcknowledged(true)
    void changeAiSettings((current) => ({
      ...withAiSubscriptionNoticeSeen(current),
      // this notice now carries the PDF sentence too, so its own supplement is read
      pdfSendNoticeSeen: 1,
    })).then((next) => {
      if (next) setSettings(next)
    })
  }, [])

  return {
    settings,
    due: !acknowledged && firstConnectionNoticeDue(settings, statuses),
    acknowledge,
  }
}

/** The notice as a dialog above whatever is open; it closes only by being acknowledged */
export function FirstConnectionDialog({ onAcknowledge }: { onAcknowledge: () => void }) {
  const { lang } = useI18n()
  const keys = useModalKeys(onAcknowledge)
  return (
    <div className="modal-overlay first-notice-overlay" ref={keys.ref} onKeyDown={keys.onKeyDown}>
      <div
        className="modal first-notice"
        role="dialog"
        aria-modal="true"
        aria-label={aiSubscriptionText(lang, 'noticeTitle')}
      >
        <AiFirstConnectionNotice
          lang={lang}
          codexKeepsHistory={CODEX_MAY_KEEP_HISTORY}
          sendsWholeDocument
          onAcknowledge={onAcknowledge}
        />
      </div>
    </div>
  )
}

/** where the home screen is when it decides whether to show the notice */
export interface HomeNoticePlace {
  /** a subscription can be used and the notice was not acknowledged */
  noticeDue: boolean
  /** Settings was opened (a connection is made there) */
  settingsVisited: boolean
  /** the ask panel is shown (it sends from the home screen) */
  askMode: boolean
  projectsMode: boolean
  /** the project screen asked for it ("[tidy up]" waits behind it) */
  projectsNoticeAsked: boolean
  translateMode: boolean
  /** the translation screen's OCR or PDF translation window asked for it before sending */
  translateNoticeAsked: boolean
}

/**
 * The home screen shows the first-connection notice where a connection is
 * made or first used from it: in Settings, on the ask panel, and on the
 * project and translation screens once one of their windows is about to send.
 * An editor's AI panel shows it for itself.
 */
export function homeFirstConnectionShown(p: HomeNoticePlace): boolean {
  return (
    p.noticeDue &&
    (p.settingsVisited ||
      p.askMode ||
      (p.projectsMode && p.projectsNoticeAsked) ||
      (p.translateMode && p.translateNoticeAsked))
  )
}
