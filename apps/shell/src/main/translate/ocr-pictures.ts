import { extname } from 'node:path'
import type { OcrMode } from '@genoffice/translate-project'
import type { OcrPopupTarget } from './ocr-popup-host'
import { allowAdHocDir } from './adhoc-dirs'
import { listEmbeddedImages, supportsEmbeddedOcr } from './embedded-images'
import { chatOcrSourceResolver } from './ocr-chat-source'

/** One picture of a workbook as the sheets AI sees it: order, sheet and anchor cell only. */
export interface WorkbookPicture {
  index: number
  sheet: string
  cell: string
}

export interface WorkbookPictureListing {
  total: number
  pictures: WorkbookPicture[]
}

export interface OcrPicturesDeps {
  /** where private project copies are made */
  workDir: () => string
  /** the OCR choice a private project starts with */
  ocrMode: () => OcrMode
  /**
   * mount the OCR selection popup as an overlay on the asking window (never a tab switch or a
   * screen); `unavailable` when no window could show it
   */
  openPopup: (asker: number, target: OcrPopupTarget) => 'opened' | 'already-open' | 'unavailable'
}

const CELL = /^[A-Z]{1,3}\d+$/

/**
 * Local, read-only access to a workbook's pictures for the sheets AI, and the request that
 * opens the OCR selection popup overlay for it. Nothing here reads an image's bytes, calls an
 * AI provider or changes the workbook: recognition only starts after the popup's own
 * confirmation, and the result goes through its placement confirmation.
 */
export function createOcrPicturesHost(deps: OcrPicturesDeps) {
  const resolve = chatOcrSourceResolver(deps.workDir, deps.ocrMode)
  const requireWorkbook = (path: string): void => {
    if (extname(path).toLowerCase() !== '.xlsx' || !supportsEmbeddedOcr(path))
      throw new Error('Picture OCR needs an .xlsx workbook')
  }
  return {
    async list(path: string): Promise<WorkbookPictureListing> {
      requireWorkbook(path)
      const images = await listEmbeddedImages(path)
      return {
        total: images.length,
        pictures: images.map((image, i) => {
          const at = image.location.lastIndexOf(' · ')
          const cell = at >= 0 ? image.location.slice(at + 3) : ''
          const sheet = at >= 0 ? image.location.slice(0, at) : image.location
          return {
            index: i + 1,
            sheet: CELL.test(cell) ? sheet : image.location,
            cell: CELL.test(cell) ? cell : '',
          }
        }),
      }
    },
    async open(path: string, asker: number): Promise<{ opened: boolean; alreadyOpen: boolean }> {
      requireWorkbook(path)
      const target = await resolve(
        0,
        { action: 'inspect', turnId: 'sheets-pictures' },
        { docPath: path, projectRoot: null },
      )
      if (!('dir' in target)) throw new Error('This workbook is not a source of its project')
      allowAdHocDir(target.dir)
      const outcome = deps.openPopup(asker, { dir: target.dir, file: target.file })
      return { opened: outcome !== 'unavailable', alreadyOpen: outcome === 'already-open' }
    },
  }
}
