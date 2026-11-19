import { EventEmitter } from 'node:events'
import type { WebContentsView } from 'electron'
import { expect, it, vi } from 'vitest'
import { setEditorViewVisible, trackSheetViewVisibility } from '../src/main/grid-view-visibility'
import { IPC_CHANNELS } from '../src/shared/ipc-channels'

it('synchronizes a prewarmed or reloaded sheet and sends only visibility changes', () => {
  let visible = true
  const wc = Object.assign(new EventEmitter(), { send: vi.fn(), isDestroyed: () => false })
  const view = {
    webContents: wc,
    getVisible: () => visible,
    setVisible: (next: boolean) => {
      visible = next
    },
  } as unknown as WebContentsView
  trackSheetViewVisibility(view)
  setEditorViewVisible(view, false)
  expect(wc.send).not.toHaveBeenCalled()
  wc.emit('dom-ready')
  setEditorViewVisible(view, true)
  setEditorViewVisible(view, true)
  wc.emit('dom-ready')
  setEditorViewVisible(view, false)
  expect(wc.send.mock.calls).toEqual(
    [false, true, true, false].map((value) => [IPC_CHANNELS.gridViewVisibility, value]),
  )
})
