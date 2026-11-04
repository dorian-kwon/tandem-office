import { useEffect, useRef, useState } from 'react'
import type { AiSettings } from '@genoffice/ai-provider/browser'
import type { SourceEntry } from '@genoffice/translate-project'
import type { TranslateOpenTranslationResult } from '../../../shared/translate-api'
import { useI18n } from '../locale'
import type { SubscriptionConnection } from '../subscription-client'
import { OcrSelectDialog } from './OcrSelectDialog'
import { PdfTranslateDialog } from './PdfTranslateDialog'
import { ProjectDetail } from './ProjectDetail'
import { ProjectList } from './ProjectList'
import { makeText, translateErrorText } from './shared'
import { markSourceChanged } from './source-change-notice'
import './translate-global'

/**
 * The translation tool's home screen: the project list, or one project's
 * detail screen once opened. "Open translation" on a source asks main which
 * flow it needs (main: translate/open-translation.ts):
 *
 * - an editable document: the translation view is open already;
 * - a text PDF: the PDF translation window (confirmation, job, translated
 *   PDF in output/), then the PDF opens beside the read-only source copy;
 * - a scanned PDF or an image: the OCR window (Task 10b), then its Word
 *   document opens beside the source copy and is translated with the AI panel.
 *
 * When an earlier result is in output/, the person first chooses between
 * opening it and running again, so a finished OCR or translation is not paid
 * for twice by accident (for a PDF, the translation window offers that
 * choice itself, with "Continue" when part of it is stored). Failures and a changed source copy are reported on
 * the detail screen.
 */

export interface TranslationPanelProps {
  /** the AI settings as last read; null until they are (Home owns them) */
  aiSettings?: AiSettings | null
  /** the live subscription connection (AppFrame owns the one instance) */
  connection?: SubscriptionConnection
  /** a window needs the first-connection notice: the home screen shows it */
  onNoticeNeeded?: () => void
  /** open Settings at the AI section */
  onOpenAiSettings?: () => void
}

type Flow =
  | { kind: 'choose'; dir: string; file: string; existing: string }
  | { kind: 'pdf'; dir: string; file: string; existing: string | null }
  | { kind: 'ocr'; dir: string; source: SourceEntry }

export function TranslationPanel(props: TranslationPanelProps = {}) {
  const { lang } = useI18n()
  const s = makeText(lang)
  const [openDir, setOpenDir] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ text: string; isError: boolean } | null>(null)
  const [flow, setFlow] = useState<Flow | null>(null)
  // a PDF's kind may change when it is opened (scan detection): the detail screen reloads
  const [listsVersion, setListsVersion] = useState(0)
  // the project the newest open request belongs to: a late answer for another
  // project (the person went back and opened a different one) is dropped
  const current = useRef<string | null>(null)
  useEffect(() => {
    current.current = openDir
    setNotice(null)
  }, [openDir])

  const fail = (dir: string, err: unknown) => {
    if (current.current !== dir) return
    setNotice({ text: translateErrorText(lang, err), isError: true })
  }

  /** the result beside the read-only source copy */
  const openResult = async (dir: string, file: string, output: string): Promise<void> => {
    try {
      await window.translateApi?.openResult({ dir, file, output })
    } catch (err) {
      fail(dir, err)
    }
  }

  /** the source entry as project.json has it now (the OCR window lists by it) */
  const startOcr = async (dir: string, file: string): Promise<void> => {
    try {
      const project = await window.translateApi?.getProject(dir)
      const source = project?.sources.find((src) => src.file === file)
      if (!source || current.current !== dir) return
      setFlow({ kind: 'ocr', dir, source })
    } catch (err) {
      fail(dir, err)
    }
  }

  const handleOpened = async (
    dir: string,
    file: string,
    result: TranslateOpenTranslationResult,
  ): Promise<void> => {
    try {
      if (result.flow === 'edit') {
        // the tab strip shows it over the split; the detail screen keeps it too
        if (result.hashStatus === 'changed') markSourceChanged(result.sourceTabId)
        if (current.current !== dir) return
        setNotice(
          result.hashStatus === 'changed' ? { text: s('warnSourceChanged'), isError: false } : null,
        )
        return
      }
      if (current.current !== dir) return
      setListsVersion((n) => n + 1)
      if (result.hashStatus === 'changed')
        setNotice({ text: s('warnSourceChanged'), isError: false })
      // the PDF window makes its own choice (continue, translate again, open the result)
      // from the engine's estimate; the OCR asks here
      if (result.flow === 'translate-pdf') {
        setFlow({ kind: 'pdf', dir, file, existing: result.existing })
        return
      }
      if (result.existing) {
        setFlow({ kind: 'choose', dir, file, existing: result.existing })
        return
      }
      await startOcr(dir, file)
    } catch (err) {
      fail(dir, err)
    }
  }

  const startTranslation = async (dir: string, file: string): Promise<void> => {
    const api = window.translateApi
    if (!api) return
    setNotice(null)
    let result: TranslateOpenTranslationResult
    try {
      result = await api.openTranslation({ dir, file })
    } catch (err) {
      fail(dir, err)
      return
    }
    await handleOpened(dir, file, result)
  }

  const close = () => setFlow(null)
  const connection = props.connection
  const aiSettings = props.aiSettings ?? null
  const openAiSettings = props.onOpenAiSettings ?? (() => undefined)

  if (openDir === null)
    return (
      <ProjectList
        onOpen={setOpenDir}
        onOpenRecent={async (dir, file) => {
          const api = window.translateApi
          if (!api) return
          // navigate only after the open worked; a failure stays on the list
          const result = await api.openTranslation({ dir, file })
          current.current = dir
          setOpenDir(dir)
          setNotice(null)
          await handleOpened(dir, file, result)
        }}
      />
    )
  return (
    <>
      <ProjectDetail
        dir={openDir}
        onBack={() => setOpenDir(null)}
        onStartTranslation={(file) => void startTranslation(openDir, file)}
        onStartOcr={(file) => void startOcr(openDir, file)}
        startNotice={notice}
        listsVersion={listsVersion}
      />
      {flow?.kind === 'choose' && (
        <div className="modal-overlay">
          <div
            className="modal translate-existing"
            role="dialog"
            aria-modal="true"
            aria-label={s('existingTitle')}
          >
            <h3>{s('existingTitle')}</h3>
            <p data-existing={flow.existing}>{s('existingText', { file: flow.existing })}</p>
            <div className="modal-buttons">
              <button type="button" className="btn btn-secondary" onClick={close}>
                {s('cancel')}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                data-action="again"
                onClick={() => {
                  const { dir, file } = flow
                  setFlow(null)
                  void startOcr(dir, file)
                }}
              >
                {s('existingAgainOcr')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                data-action="open-existing"
                onClick={() => {
                  const { dir, file, existing } = flow
                  setFlow(null)
                  void openResult(dir, file, existing)
                }}
              >
                {s('existingOpen')}
              </button>
            </div>
          </div>
        </div>
      )}
      {flow?.kind === 'pdf' && connection && (
        <PdfTranslateDialog
          dir={flow.dir}
          file={flow.file}
          existing={flow.existing}
          aiSettings={aiSettings}
          connection={connection}
          {...(props.onNoticeNeeded ? { onNoticeNeeded: props.onNoticeNeeded } : {})}
          onOpenAiSettings={openAiSettings}
          onOpenResult={(output) => void openResult(flow.dir, flow.file, output)}
          onClose={close}
        />
      )}
      {flow?.kind === 'ocr' && connection && (
        <OcrSelectDialog
          dir={flow.dir}
          sources={[flow.source]}
          aiSettings={aiSettings}
          connection={connection}
          {...(props.onNoticeNeeded ? { onNoticeNeeded: props.onNoticeNeeded } : {})}
          onOpenAiSettings={openAiSettings}
          // the Word document opens beside the source as soon as it is written
          onFinished={(result) =>
            void openResult(flow.dir, flow.source.file, baseName(result.outputPath))
          }
          onOpenResult={(outputPath) =>
            void openResult(flow.dir, flow.source.file, baseName(outputPath))
          }
          onClose={close}
        />
      )}
    </>
  )
}

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path
