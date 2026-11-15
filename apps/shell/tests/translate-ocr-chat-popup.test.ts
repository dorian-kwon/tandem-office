import { describe, expect, it, vi } from 'vitest'
import { createOcrChatPopup } from '../src/main/translate/ocr-chat-popup'
import type { OcrPopupOutcome } from '../src/main/translate/ocr-popup-host'

/**
 * The chat tool's side of the OCR popup: it opens the popup over the asking window, waits for the
 * person to finish or close it, and hears of it before the sheets AI's own listener would.
 */

const target = { dir: '/work/x', file: 'book.docx' }
const result: OcrPopupOutcome = {
  kind: 'result',
  result: { pages: [{ index: 2, location: 'loc', text: 'Menu' }] },
}

function setup(open: 'opened' | 'already-open' | 'unavailable' = 'opened') {
  const host = {
    open: vi.fn(() => open),
    askerGone: vi.fn(),
  }
  const allowDir = vi.fn()
  const chat = createOcrChatPopup({ host, allowDir })
  return { host, allowDir, chat }
}

describe('the chat tool waiting for the OCR popup', () => {
  it('lets the popup read the work folder, opens it for the asker and waits for its result', async () => {
    const { host, allowDir, chat } = setup()
    const pending = chat.popup.ask(7, target, new AbortController().signal)
    expect(allowDir).toHaveBeenCalledWith('/work/x')
    expect(host.open).toHaveBeenCalledWith(7, target)
    expect(chat.deliver(7, result)).toBe(true)
    expect(await pending).toEqual({ kind: 'result', result: result.result })
  })

  it('reports a popup the person closed', async () => {
    const { chat } = setup()
    const pending = chat.popup.ask(7, target, new AbortController().signal)
    chat.deliver(7, { kind: 'closed' })
    expect(await pending).toEqual({ kind: 'closed' })
  })

  it('does not wait when the popup is already open or cannot be shown', async () => {
    expect(
      await setup('already-open').chat.popup.ask(7, target, new AbortController().signal),
    ).toEqual({
      kind: 'already-open',
    })
    expect(
      await setup('unavailable').chat.popup.ask(7, target, new AbortController().signal),
    ).toEqual({
      kind: 'unavailable',
    })
  })

  it('leaves an outcome nobody waits for to the other listener', () => {
    const { chat } = setup()
    expect(chat.deliver(9, result)).toBe(false)
  })

  it('only hands an outcome to the asker that waits for it', async () => {
    const { chat } = setup()
    const pending = chat.popup.ask(7, target, new AbortController().signal)
    expect(chat.deliver(8, result)).toBe(false)
    expect(chat.deliver(7, result)).toBe(true)
    await pending
  })

  it('closes the popup and stops waiting when the run is cancelled', async () => {
    const { host, chat } = setup()
    const controller = new AbortController()
    const pending = chat.popup.ask(7, target, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow()
    expect(host.askerGone).toHaveBeenCalledWith(7)
    // a late outcome is no longer ours
    expect(chat.deliver(7, result)).toBe(false)
  })

  it('does not open a popup for a run that is already cancelled', async () => {
    const { host, chat } = setup()
    const controller = new AbortController()
    controller.abort()
    await expect(chat.popup.ask(7, target, controller.signal)).rejects.toThrow()
    expect(host.open).not.toHaveBeenCalled()
  })

  it('waits for one popup per asker at a time', async () => {
    const { chat } = setup()
    const first = chat.popup.ask(7, target, new AbortController().signal)
    const second = await chat.popup.ask(7, target, new AbortController().signal)
    expect(second).toEqual({ kind: 'already-open' })
    chat.deliver(7, { kind: 'closed' })
    await first
  })
})
