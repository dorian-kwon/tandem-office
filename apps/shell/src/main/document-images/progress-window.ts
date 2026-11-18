import { randomBytes } from 'node:crypto'
import { BrowserWindow } from 'electron'
import { htmlDir, htmlLang, type Lang } from '@genoffice/i18n'
import { imageCopyText } from './strings'

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char]!,
  )

/** A local progress surface with no document data, preload, IPC or network access. */
export function createImageCopyProgress(
  parent: BrowserWindow | null,
  lang: Lang,
  onCancel: () => void,
): { update(done: number, total: number): void; close(): void } {
  const owner = parent && !parent.isDestroyed() ? parent : null
  const window = new BrowserWindow({
    width: 440,
    height: 220,
    useContentSize: true,
    ...(owner ? { parent: owner, modal: true } : {}),
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    title: imageCopyText(lang, 'title'),
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: false,
    },
  })
  window.removeMenu()
  let programmaticClose = false
  let ready = false
  let latest: { done: number; total: number } | null = null
  window.once('closed', () => {
    if (!programmaticClose) onCancel()
  })
  window.once('ready-to-show', () => {
    if (!window.isDestroyed() && !programmaticClose) window.show()
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())

  const render = (): void => {
    if (!ready || !latest || window.isDestroyed() || window.webContents.isDestroyed()) return
    const { done, total } = latest
    const text = imageCopyText(lang, 'progress', { done, total })
    // Only text and bounded numbers cross into the trusted page; never HTML.
    const script = `(() => {
      document.getElementById('counts').textContent = ${JSON.stringify(text)};
      const bar = document.getElementById('progress');
      bar.max = ${Math.max(total, 1)};
      ${total > 0 ? `bar.value = ${Math.min(done, total)};` : "bar.removeAttribute('value');"}
    })()`
    try {
      void window.webContents.executeJavaScript(script).catch(() => {})
    } catch {
      // Closing the window can race a worker progress update.
    }
  }
  window.webContents.once('did-finish-load', () => {
    ready = true
    render()
  })
  const nonce = randomBytes(24).toString('base64')
  const title = escapeHtml(imageCopyText(lang, 'title'))
  const working = escapeHtml(imageCopyText(lang, 'working'))
  const cancel = escapeHtml(imageCopyText(lang, 'cancel'))
  const html = `<!doctype html>
<html lang="${htmlLang(lang)}" dir="${htmlDir(lang)}">
<head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'">
<title>${title}</title>
<style nonce="${nonce}">
:root { color-scheme: light dark; }
body { margin: 0; padding: 24px; background: Canvas; color: CanvasText; font: 14px system-ui, sans-serif; }
p { margin: 0 0 16px; overflow-wrap: anywhere; }
progress { display: block; width: 100%; height: 12px; accent-color: AccentColor; }
#counts { margin: 10px 0 18px; min-height: 1.2em; font-variant-numeric: tabular-nums; }
footer { display: flex; justify-content: flex-end; }
button { padding: 7px 18px; border: 1px solid ButtonBorder; border-radius: 5px; background: ButtonFace; color: ButtonText; font: inherit; cursor: pointer; }
button:focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }
</style></head>
<body><p>${working}</p><progress id="progress" aria-label="${working}"></progress>
<p id="counts" role="status" aria-live="polite"></p>
<footer><button id="cancel" type="button" autofocus>${cancel}</button></footer>
<script nonce="${nonce}">
document.getElementById('cancel').addEventListener('click', () => window.close());
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') window.close(); });
</script></body></html>`
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => {
    if (!window.isDestroyed()) window.close()
  })

  const count = (value: number): number =>
    Number.isFinite(value) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(value))) : 0
  return {
    update(done, total) {
      latest = { done: count(done), total: count(total) }
      render()
    },
    close() {
      programmaticClose = true
      if (!window.isDestroyed()) window.close()
    },
  }
}
