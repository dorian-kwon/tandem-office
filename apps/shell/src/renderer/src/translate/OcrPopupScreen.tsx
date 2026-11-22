import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import type { SourceEntry } from '@genoffice/translate-project'
import { checkOcrPopupResult } from '../../../shared/ocr-popup'
import type { TranslateApi } from '../../../shared/translate-api'
import { FirstConnectionDialog, useFirstConnectionNotice } from '../FirstConnectionNotice'
import { useSubscriptionConnection } from '../subscription-client'
import { OcrSelectDialog } from './OcrSelectDialog'
import './translate.css'
import './translate-global'

/**
 * The OCR selection popup as the app root of its own overlay view (`?mode=ocr-popup`), mounted
 * by main on top of the window of the editor whose AI asked for it. It exists regardless of
 * which tab or screen is active: no screen of the shell has to stay mounted for it.
 *
 * It only chooses the pictures (with local previews) and takes the final start confirmation.
 * The recognised text goes back to the asking AI panel (`ocrPopupResult`); where it goes is
 * decided in that chat. Closing it, by any button, tells main (`ocrPopupClosed`).
 */
export function OcrPopupScreen(props: {
  dir: string
  file: string
  editorPlacement?: boolean
  preset?: string | null
  api?: TranslateApi | undefined
}): ReactElement | null {
  const preset = useMemo(() => {
    if (!props.editorPlacement || !props.preset) return undefined
    return checkOcrPopupResult({ pages: [], placement: JSON.parse(props.preset) }).placement
  }, [props.editorPlacement, props.preset])
  const api = props.api ?? window.translateApi
  const connection = useSubscriptionConnection()
  const notice = useFirstConnectionNotice(connection.statuses)
  const [source, setSource] = useState<SourceEntry | null>(null)
  const [noticeAsked, setNoticeAsked] = useState(false)

  const close = (): void => {
    void api?.ocrPopupClosed().catch(() => undefined)
  }

  useEffect(() => {
    let alive = true
    void api?.getProject(props.dir).then(
      (project) => {
        if (!alive) return
        const found = project.sources.find((s) => s.file === props.file)
        if (found) setSource(found)
        else close()
      },
      () => alive && close(),
    )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opened overlay
  }, [])

  if (!source || !api) return null
  return (
    <>
      <OcrSelectDialog
        dir={props.dir}
        sources={[source]}
        aiSettings={notice.settings}
        connection={connection}
        api={api}
        selectOnly
        editorPlacement={props.editorPlacement}
        presetPlacement={preset}
        onNoticeNeeded={() => setNoticeAsked(true)}
        // Settings live in the home screen: end this popup rather than navigate there
        onOpenAiSettings={close}
        onRecognised={(result) => void api.ocrPopupResult(result).catch(close)}
        onClose={close}
      />
      {noticeAsked && notice.due && <FirstConnectionDialog onAcknowledge={notice.acknowledge} />}
    </>
  )
}
