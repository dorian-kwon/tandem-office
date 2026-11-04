import { expect, it } from 'vitest'
import {
  createOcrPopupHost,
  type OcrPopupDeps,
  type OcrPopupOutcome,
} from '../src/main/translate/ocr-popup-host'

/**
 * The OCR selection popup is an overlay mounted by main on the asking window. These tests use
 * fake views: no Electron, no AI. What matters is who owns the lifecycle (main, not a screen).
 */

function setup(over: Partial<OcrPopupDeps> = {}) {
  let nextPopup = 100
  const destroyed: number[] = []
  const delivered: { asker: number; outcome: OcrPopupOutcome }[] = []
  const mounted: { asker: number; popupId: number }[] = []
  const deps: OcrPopupDeps = {
    mount: (asker) => {
      const popupId = nextPopup++
      mounted.push({ asker, popupId })
      return { popupId, destroy: () => destroyed.push(popupId) }
    },
    deliver: (asker, outcome) => delivered.push({ asker, outcome }),
    ...over,
  }
  return { host: createOcrPopupHost(deps), destroyed, delivered, mounted }
}

const target = { dir: '/work/p', file: 'a.xlsx' }
const result = { pages: [{ index: 1, location: 'S · A7', text: 'hello' }] }

it('opens one overlay per asking window; a second request is not a second popup or job', () => {
  const { host, mounted } = setup()
  expect(host.open(7, target)).toBe('opened')
  expect(host.open(7, target)).toBe('already-open')
  expect(mounted).toHaveLength(1)
  expect(host.open(8, target)).toBe('opened')
  expect(mounted).toHaveLength(2)
})

it('reports when no window could show the overlay', () => {
  const { host } = setup({ mount: () => null })
  expect(host.open(7, target)).toBe('unavailable')
})

it('delivers the popup result to the asking panel and removes the overlay', () => {
  const { host, delivered, destroyed } = setup()
  host.open(7, target)
  expect(host.complete(100, result)).toBe(true)
  expect(delivered).toEqual([{ asker: 7, outcome: { kind: 'result', result } }])
  expect(destroyed).toEqual([100])
  expect(host.open(7, target)).toBe('opened')
})

it('accepts a result only from the popup it mounted', () => {
  const { host, delivered } = setup()
  host.open(7, target)
  expect(host.complete(999, result)).toBe(false)
  expect(host.cancel(999)).toBe(false)
  expect(delivered).toEqual([])
})

it('a cancelled popup tells the panel it closed without a result', () => {
  const { host, delivered, destroyed } = setup()
  host.open(7, target)
  expect(host.cancel(100)).toBe(true)
  expect(delivered).toEqual([{ asker: 7, outcome: { kind: 'closed' } }])
  expect(destroyed).toEqual([100])
})

it('closing the asking window cancels the popup and its job quietly', () => {
  const { host, delivered, destroyed } = setup()
  host.open(7, target)
  host.askerGone(7)
  expect(destroyed).toEqual([100])
  expect(delivered).toEqual([])
  expect(host.open(7, target)).toBe('opened')
})

it('has no reaction to tab switches: only complete, cancel or the asker closing end the popup', () => {
  const { host, destroyed } = setup()
  host.open(7, target)
  expect(destroyed).toEqual([])
  expect(host.isOpen(7)).toBe(true)
})

it('an overlay that ended by itself frees the slot and tells the panel', () => {
  const { host, delivered } = setup()
  host.open(7, target)
  host.viewGone(100)
  expect(delivered).toEqual([{ asker: 7, outcome: { kind: 'closed' } }])
  expect(host.isOpen(7)).toBe(false)
})

it('knows its own overlays so only they may use the OCR channels besides the shell window', () => {
  const { host } = setup()
  host.open(7, target)
  expect(host.isPopupSender(100)).toBe(true)
  expect(host.isPopupSender(7)).toBe(false)
  host.cancel(100)
  expect(host.isPopupSender(100)).toBe(false)
})
