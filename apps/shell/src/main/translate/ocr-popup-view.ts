import { WebContentsView, type BrowserWindow } from 'electron'
import { rendererUrl } from '@genoffice/electron-utils'
import type { OcrPopupTarget, OcrPopupView } from './ocr-popup-host'

/**
 * Mount the OCR popup as an overlay view that covers the content area of the asking window.
 * It is a child view of that same window, not another window and not a tab: the shell does
 * not switch screens, and the view stays above the editor views until main removes it.
 * `onGone` fires when its contents end by themselves (crash, closed); `destroy` removes it,
 * and the renderer's own cleanup then stops a running read and frees its lease.
 */
export function mountOcrPopupView(options: {
  window: BrowserWindow
  target: OcrPopupTarget
  preloadPath: string
  onGone: (popupId: number) => void
}): OcrPopupView {
  const { window: win, target } = options
  const view = new WebContentsView({
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  })
  view.setBackgroundColor('#00000000')
  // never a second window or an external page from inside the overlay
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const popupId = view.webContents.id
  const fit = (): void => {
    const [width, height] = win.getContentSize()
    view.setBounds({ x: 0, y: 0, width: width ?? 0, height: height ?? 0 })
  }
  // a view added later (a new tab) lands above this one; adding it again moves it back on top
  const raise = (): void => {
    if (win.isDestroyed() || view.webContents.isDestroyed()) return
    win.contentView.addChildView(view)
    fit()
  }
  let destroyed = false
  const detach = (): void => {
    win.off('resize', fit)
    win.off('focus', raise)
  }
  win.contentView.addChildView(view)
  fit()
  win.on('resize', fit)
  win.on('focus', raise)
  view.webContents.once('destroyed', () => {
    detach()
    if (!destroyed) options.onGone(popupId)
  })
  view.webContents.once('render-process-gone', () => {
    if (!destroyed) options.onGone(popupId)
  })
  void view.webContents.loadURL(
    rendererUrl(process.env.ELECTRON_RENDERER_URL, 'help', {
      mode: 'ocr-popup',
      dir: target.dir,
      file: target.file,
      ...(target.purpose ? { purpose: target.purpose } : {}),
      ...(target.placement ? { placement: JSON.stringify(target.placement) } : {}),
    }),
  )
  view.webContents.focus()
  return {
    popupId,
    destroy: () => {
      if (destroyed) return
      destroyed = true
      detach()
      if (!win.isDestroyed()) win.contentView.removeChildView(view)
      if (!view.webContents.isDestroyed()) view.webContents.close()
    },
  }
}
