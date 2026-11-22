import { dialog, Menu, type BrowserWindow } from 'electron'
import { basename } from 'node:path'
import type { Lang } from '@genoffice/i18n'
import { fileConversionText } from '../renderer/src/i18n/strings-file-conversion'
import type { CliRunner } from './mcp/cli-runner'
import { canApplyEditorOcr, editorOcrFormats, writeEditorOcr } from './editor-ocr'
import type { OcrPlacement } from '../shared/translate-ocr'
import { pickEditorOcrLocation } from './editor-ocr-location'
import { installedOcrLanguages, recognizeFile } from './ocr-file-ipc'

interface EditorOcrAction {
  owner: BrowserWindow
  lang: Lang
  path: string
  readOnly: boolean
  outputDir: string
  cancelLabel: string
  saveLabel: string
  current(): Promise<boolean>
  dirty(): Promise<boolean>
  save(): Promise<void>
  open(path: string, applied: boolean): void
  insertAtDestination(
    apply: boolean,
    keepFormatting: boolean,
    placement?: OcrPlacement,
  ): Promise<string | undefined>
  cli(): CliRunner
}

export async function runEditorOcrAction(opts: EditorOcrAction): Promise<void> {
  const { owner, lang, path, readOnly } = opts
  const t = (key: Parameters<typeof fileConversionText>[1]) => fileConversionText(lang, key)
  const formats = editorOcrFormats(path)
  async function saveIfNeeded() {
    if (await opts.dirty()) {
      const { response } = await dialog.showMessageBox(owner, {
        type: 'question',
        title: t('ocrTitle'),
        message: t('ocrSaveBeforeRun'),
        buttons: [opts.saveLabel, opts.cancelLabel],
        defaultId: 0,
        cancelId: 1,
      })
      if (response !== 0 || !(await opts.current())) return false
      await opts.save()
    }
    return await opts.current()
  }
  try {
    const mode = await dialog.showMessageBox(owner, {
      type: 'question',
      title: t('ocrTitle'),
      message: t('ocrKeepFormattingQuestion'),
      detail: basename(path),
      buttons: [t('ocrLayoutCopy'), t('ocrTextOnly'), opts.cancelLabel],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    })
    if (mode.response === 2 || !(await opts.current())) return
    const keepFormatting = mode.response === 0
    const location = await pickEditorOcrLocation(owner, lang, path, opts.cli(), keepFormatting)
    if (!location || !(await opts.current())) return
    const format =
      location.kind === 'pdf'
        ? 'pdf'
        : (formats.find((f) => ['xlsx', 'xlsm'].includes(f)) ?? 'docx')
    let apply = false
    if (canApplyEditorOcr(path, readOnly, format)) {
      const selected = await dialog.showMessageBox(owner, {
        type: 'question',
        title: t('ocrTitle'),
        message: t('ocrOutputPrompt'),
        detail: basename(path),
        buttons: [t('ocrResultCopy'), t('ocrApplyOriginal'), opts.cancelLabel],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      })
      if (selected.response === 2 || !(await opts.current())) return
      apply = selected.response === 1
    }
    if (location.kind === 'chosen') {
      if (!(await saveIfNeeded())) return
      const output = await opts.insertAtDestination(apply, keepFormatting, location.placement)
      if (output) opts.open(output, output === path)
      return
    }
    const choice = { format, apply }
    const { response } = await dialog.showMessageBox(owner, {
      type: 'question',
      title: t('ocrTitle'),
      message: t('ocrLanguage'),
      buttons: [t('ocrLanguageDefault'), t('ocrLanguage'), opts.cancelLabel],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    })
    if (response === 2 || !(await opts.current())) return
    let language: string | undefined
    if (response === 1) {
      const languages = await installedOcrLanguages()
      if (!languages.length) throw new Error('OCR_LANGUAGE_UNAVAILABLE')
      language = await new Promise<string | undefined>((resolve) => {
        const display = new Intl.DisplayNames([lang], { type: 'language' })
        const menu = Menu.buildFromTemplate(
          languages.map((code) => ({
            label: (display.of(code) ?? code) + ' (' + code + ')',
            click: () => resolve(code),
          })),
        )
        menu.popup({ window: owner, callback: () => setImmediate(() => resolve(undefined)) })
      })
      if (!language || !(await opts.current())) return
    }
    if (!(await saveIfNeeded())) return
    const result = await writeEditorOcr(path, choice, {
      readOnly,
      outputDir: opts.outputDir,
      current: async () => (await opts.current()) && !(await opts.dirty()),
      recognize: (source, format, output) =>
        recognizeFile(
          source,
          format,
          output,
          {
            language,
            ...(location.kind === 'native'
              ? { placement: location.placement, plainText: !keepFormatting }
              : {}),
          },
          lang,
          opts.cli(),
        ),
    })
    if (result.outputPath) opts.open(result.outputPath, choice.apply)
    if (result.warning && !owner.isDestroyed())
      await dialog.showMessageBox(owner, { type: 'warning', message: result.warning })
  } catch (error) {
    if (owner.isDestroyed()) return
    const message = error instanceof Error ? error.message : String(error)
    const labels = {
      OCR_DOCUMENT_CHANGED: 'ocrDocumentChanged',
      OCR_LANGUAGE_UNAVAILABLE: 'ocrLanguageUnavailable',
      OCR_NO_TEXT: 'ocrNoText',
      OCR_UNAVAILABLE: 'ocrUnavailable',
    } as const
    const key = labels[message as keyof typeof labels]
    await dialog.showMessageBox(owner, {
      type: 'error',
      message: t('ocrDocumentFailed'),
      detail: key ? t(key) : message,
    })
  }
}
