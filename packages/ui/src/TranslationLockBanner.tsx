import React from 'react'
import { brandText, type Lang } from '@genoffice/i18n'
import { TRANSLATION_LOCK_STRINGS } from './strings-translation-lock'
import './translation-lock.css'

/**
 * The note on the translation output pane while the AI translates. The Unlock
 * button is always there: it releases the lock and stops the run, so the lock
 * can never trap the person.
 */
export function TranslationLockBanner({
  lang,
  onUnlock,
}: {
  readonly lang: Lang
  readonly onUnlock: () => void
}): React.JSX.Element {
  const t = TRANSLATION_LOCK_STRINGS[lang]
  return (
    <div className="translation-lock-banner" role="status" aria-live="polite">
      <span className="translation-lock-banner-text">{brandText(t.banner, lang)}</span>
      <button type="button" className="translation-lock-banner-button" onClick={onUnlock}>
        {t.unlock}
      </button>
    </div>
  )
}
