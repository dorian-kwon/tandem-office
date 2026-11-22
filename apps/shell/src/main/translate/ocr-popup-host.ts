import type { OcrPlacement } from '../../shared/translate-ocr'
import type { OcrPopupResult } from '../../shared/ocr-popup'

/** What the asking panel is told when the popup ends. */
export type OcrPopupOutcome = { kind: 'result'; result: OcrPopupResult } | { kind: 'closed' }

export interface OcrPopupTarget {
  purpose?: 'editor'
  placement?: OcrPlacement
  dir: string
  file: string
}

export interface OcrPopupView {
  /** webContents id of the popup; the only sender allowed to complete or cancel it */
  popupId: number
  /** remove the overlay; its renderer's cleanup stops a running read and releases its token */
  destroy(): void
}

export interface OcrPopupDeps {
  /** mount the overlay on the window of this asking webContents; null when no window can show it */
  mount(asker: number, target: OcrPopupTarget): OcrPopupView | null
  /** tell the asking panel how the popup ended */
  deliver(asker: number, outcome: OcrPopupOutcome): void
}

/**
 * The OCR selection popup's lifecycle, owned by main so no screen has to stay mounted for it:
 * one overlay per asking window, ended only by the person finishing, cancelling, or the asking
 * window closing (then nobody is told and the overlay's read is torn down with it).
 */
export function createOcrPopupHost(deps: OcrPopupDeps) {
  const byAsker = new Map<number, OcrPopupView>()
  const askerOf = (popupId: number): number | undefined => {
    for (const [asker, view] of byAsker) if (view.popupId === popupId) return asker
    return undefined
  }
  const end = (asker: number, outcome: OcrPopupOutcome | null): void => {
    const view = byAsker.get(asker)
    if (!view) return
    byAsker.delete(asker)
    view.destroy()
    if (outcome) deps.deliver(asker, outcome)
  }
  return {
    open(asker: number, target: OcrPopupTarget): 'opened' | 'already-open' | 'unavailable' {
      if (byAsker.has(asker)) return 'already-open'
      const view = deps.mount(asker, target)
      if (!view) return 'unavailable'
      byAsker.set(asker, view)
      return 'opened'
    },
    isOpen: (asker: number): boolean => byAsker.has(asker),
    /** whether this webContents is a popup overlay main mounted (it may use the OCR channels) */
    isPopupSender(senderId: number): boolean {
      return askerOf(senderId) !== undefined
    },
    /** the popup finished reading: hand the text to the asking panel */
    complete(popupId: number, result: OcrPopupResult): boolean {
      const asker = askerOf(popupId)
      if (asker === undefined) return false
      end(asker, { kind: 'result', result })
      return true
    },
    /** the person dismissed the popup */
    cancel(popupId: number): boolean {
      const asker = askerOf(popupId)
      if (asker === undefined) return false
      end(asker, { kind: 'closed' })
      return true
    },
    /** the asking window or tab went away */
    askerGone(asker: number): void {
      end(asker, null)
    },
    /** the overlay's own contents ended without the host asking (crash, destroyed) */
    viewGone(popupId: number): void {
      const asker = askerOf(popupId)
      if (asker === undefined) return
      byAsker.delete(asker)
      deps.deliver(asker, { kind: 'closed' })
    },
  }
}
export type OcrPopupHost = ReturnType<typeof createOcrPopupHost>
