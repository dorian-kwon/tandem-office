import { copyFile, rm } from 'node:fs/promises'
import { extname } from 'node:path'
import type { OcrPlacement } from '../shared/translate-ocr'
import type { OcrMode } from '@genoffice/translate-project'
import { writeEditorOcr } from './editor-ocr'
import { forgetAdHocDir } from './translate/adhoc-dirs'
import { chatOcrSourceResolver } from './translate/ocr-chat-source'
import { textPayload, type OcrChatPopup } from './translate/ocr-chat'
import type { OcrService } from './translate/ocr'

export const supportsEditorOcrInsert = (path: string) => /\.(docx|xlsx|hwpx|hwp|pdf)$/i.test(path)

interface EditorOcrInsertOptions {
  ownerId: number
  path: string
  /** File shown in the tab when recognition reads its prepared PDF. */
  originalPath?: string
  outputDir: string
  readOnly: boolean
  apply: boolean
  keepFormatting?: boolean
  placement?: OcrPlacement
  current(): Promise<boolean>
  workDir(): string
  ocrMode(): OcrMode
  ocr: Pick<OcrService, 'prepare' | 'start' | 'write' | 'release'>
  popup: OcrChatPopup
  signal: AbortSignal
}

/** The editor toolbar uses the same selection, consent, recognition and placement writer
 * as a project. Only the file actually open in this tab can become its private source. */
export async function runEditorOcrInsert(
  opts: EditorOcrInsertOptions,
): Promise<{ outputPath: string } | null> {
  if (!supportsEditorOcrInsert(opts.path)) throw Error('OCR_UNAVAILABLE')
  const format = extname(opts.path).toLowerCase() === '.xlsx' ? 'xlsx' : 'docx'
  const originalPath = opts.originalPath ?? opts.path
  if (opts.apply && originalPath !== opts.path) throw Error('OCR_UNAVAILABLE')
  const cancelled = new Error('OCR_CANCELLED')
  const current = async () => !opts.signal.aborted && (await opts.current())
  const resolve = chatOcrSourceResolver(opts.workDir, opts.ocrMode, { currentFileOnly: true })
  try {
    const result = await writeEditorOcr(
      originalPath,
      { format, apply: opts.apply },
      {
        outputDir: opts.outputDir,
        readOnly: opts.readOnly,
        current,
        recognize: async (_source, _format, staged) => {
          const target = await resolve(
            opts.ownerId,
            { action: 'inspect', turnId: 'editor-toolbar' },
            {
              docPath: opts.path,
              projectRoot: null,
            },
          )
          if (!('dir' in target) || !target.besideSourceDir) throw Error('OCR_UNAVAILABLE')
          let token: string | undefined
          try {
            if (!(await current())) throw Error('OCR_DOCUMENT_CHANGED')
            const outcome = await opts.popup.ask(
              opts.ownerId,
              {
                dir: target.dir,
                file: target.file,
                purpose: 'editor',
                ...(opts.placement ? { placement: opts.placement } : {}),
              },
              opts.signal,
            )
            if (outcome.kind === 'unavailable') throw Error('OCR_UNAVAILABLE')
            if (outcome.kind !== 'result') throw cancelled
            if (!(await current())) throw Error('OCR_DOCUMENT_CHANGED')
            const { pages, newDocument } = outcome.result
            // A renderer may fill in coordinates only for the selected on-image boxes.
            const placement =
              opts.placement?.kind === 'docx-image-boxes'
                ? {
                    kind: 'docx-image-boxes' as const,
                    images: pages.flatMap((p) =>
                      p.boxes?.length ? [{ index: p.index, boxes: p.boxes }] : [],
                    ),
                  }
                : (opts.placement ?? outcome.result.placement)
            if (!pages.length) throw Error('OCR_NO_TEXT')
            // The overlay released its preview/recognition lease on close. Rebind only the
            // chosen result indices to the same private snapshot. This makes no OCR calls.
            const prepared = await opts.ocr.prepare(target.dir, [target.file], opts.ownerId)
            token = prepared.token
            if (
              prepared.kind === 'embedded' ? !placement || newDocument : !newDocument || placement
            )
              throw Error('OCR_UNAVAILABLE')
            await opts.ocr.start(
              token,
              pages.map((p) => p.index),
            )
            const readings = pages.map((p) => ({
              index: p.index,
              payload:
                opts.keepFormatting === false && placement?.kind !== 'docx-image-boxes'
                  ? textPayload(p.text)
                  : (p.form ??
                    (p.boxes?.length
                      ? { kind: 'boxes', boxes: p.boxes, text: p.text }
                      : textPayload(p.text))),
            }))
            const written = await opts.ocr.write(token, readings, placement)
            await copyFile(written.outputPath, staged)
          } finally {
            if (token) await opts.ocr.release(token).catch(() => undefined)
            forgetAdHocDir(target.dir)
            await rm(target.dir, { recursive: true, force: true })
          }
        },
      },
    )
    return result.outputPath ? { outputPath: result.outputPath } : null
  } catch (error) {
    if (error === cancelled || opts.signal.aborted) return null
    throw error
  }
}
