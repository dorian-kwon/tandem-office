import React from 'react'
import { createRoot } from 'react-dom/client'
import { htmlDir, htmlLang, productName } from '@genoffice/i18n'
import { AppFrame } from './AppFrame'
import { LocaleProvider } from './locale'
import '@genoffice/ui/tokens.css'
import '@genoffice/ui/screentip.css'
import '@genoffice/ui/dropdown.css'
import '@genoffice/ui/ai-usage.css'
import './home.css'
import './tabbar.css'
import { installScreenTips } from '@genoffice/ui'
import { watchMcpOpenServer } from './mcp/mcp-open-request'

installScreenTips()
// an AI window's "open in Settings" may name its server before the card is on screen
watchMcpOpenServer()

// macOS shell window is created with vibrancy; a transparent body lets the
// editor views' translucent regions (e.g. slides thumbnail pane) show it
const IS_MAC = navigator.platform.toLowerCase().includes('mac')
if (IS_MAC) document.body.classList.add('vib')
// non-mac: the tab strip doubles as the title bar (caption buttons overlay it)
document.body.classList.add(IS_MAC ? 'mac' : 'overlay-title-bar')

// resolve the persisted language, first-run flag, and theme before first paint
// so the UI never flashes (home showing briefly before the onboarding overlay)
void Promise.all([
  window.aiOffice.getLanguage(),
  // if the flag is unreadable, skip onboarding rather than block the home screen
  window.aiOffice.onboardingSeen().catch(() => true),
  window.aiOffice.getTheme().catch(() => 'system' as const),
]).then(([lang, onboardingSeen, theme]) => {
  document.documentElement.lang = htmlLang(lang)
  document.documentElement.dir = htmlDir(lang)
  // the window (taskbar) title follows the page title
  document.title = productName(lang)
  // apply theme attribute before first paint to avoid flash
  if (theme !== 'system') {
    document.documentElement.setAttribute('data-theme', theme)
  }
  window.aiOffice.onThemeChanged((next) => {
    if (next === 'system') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', next)
  })
  // The manual tab is the same bundle branched on ?mode=help: no onboarding,
  // no home state, just the searchable topic browser (issue #1520).
  //
  // Split, though: this entry chunk is parsed on every launch whatever the tab
  // is, and the screen plus its stylesheet are only ever wanted on the other
  // one. A static import meant Home's first paint paid for a manual nobody had
  // opened.
  const query = new URLSearchParams(location.search)
  const isHelp = query.get('mode') === 'help'
  // the OCR popup overlay main mounts over an editor window (a view, not a screen)
  const ocrPopup =
    query.get('mode') === 'ocr-popup' && query.get('dir') && query.get('file')
      ? { dir: query.get('dir') as string, file: query.get('file') as string }
      : null
  if (ocrPopup) document.documentElement.classList.add('ocr-popup-root')
  const OcrPopupScreen = React.lazy(() =>
    import('./translate/OcrPopupScreen').then((m) => ({ default: m.OcrPopupScreen })),
  )
  const HelpScreen = React.lazy(() =>
    import('./i18n/help/HelpScreen').then((m) => ({ default: m.HelpScreen })),
  )
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <LocaleProvider initial={lang}>
        {ocrPopup ? (
          <React.Suspense fallback={null}>
            <OcrPopupScreen dir={ocrPopup.dir} file={ocrPopup.file} />
          </React.Suspense>
        ) : isHelp ? (
          <React.Suspense fallback={<div className="boot" />}>
            <HelpScreen />
          </React.Suspense>
        ) : (
          <AppFrame initialOnboardingSeen={onboardingSeen} />
        )}
      </LocaleProvider>
    </React.StrictMode>,
  )
})
