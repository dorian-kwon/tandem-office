import type { OcrChatPopup } from './ocr-chat'
import type { OcrPopupOutcome, OcrPopupTarget } from './ocr-popup-host'

export interface OcrChatPopupDeps {
  /** the popup host's `open` and `askerGone` */
  host: {
    open(asker: number, target: OcrPopupTarget): 'opened' | 'already-open' | 'unavailable'
    askerGone(asker: number): void
  }
  /** let the popup's own screen read this work folder through the translation channels */
  allowDir(dir: string): void
}

/**
 * The chat tool's side of the OCR selection popup. `popup.ask` opens it over the asking window and
 * waits for the person to finish or close it. `deliver` is the first listener for how a popup
 * ended: it answers true when a chat tool was waiting for that asker (the outcome is then its
 * own), and false when it was not, so the sheets AI's listener gets it as before.
 */
export function createOcrChatPopup(deps: OcrChatPopupDeps) {
  const waiting = new Map<number, (outcome: OcrPopupOutcome) => void>()
  const popup: OcrChatPopup = {
    ask(owner, target, signal) {
      return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(new Error('cancelled'))
        if (waiting.has(owner)) return resolve({ kind: 'already-open' })
        deps.allowDir(target.dir)
        const opened = deps.host.open(owner, target)
        if (opened !== 'opened') return resolve({ kind: opened })
        const onAbort = () => {
          waiting.delete(owner)
          // the overlay goes with its running read; nobody is told
          deps.host.askerGone(owner)
          reject(new Error('cancelled'))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        waiting.set(owner, (outcome) => {
          signal.removeEventListener('abort', onAbort)
          resolve(outcome.kind === 'result' ? outcome : { kind: 'closed' })
        })
      })
    },
  }
  return {
    popup,
    deliver(asker: number, outcome: OcrPopupOutcome): boolean {
      const waiter = waiting.get(asker)
      if (!waiter) return false
      waiting.delete(asker)
      waiter(outcome)
      return true
    },
  }
}
