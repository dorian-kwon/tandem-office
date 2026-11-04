/**
 * One choke point for every editor's own Save As (menu, ribbon, shortcut).
 *
 * The translation view's output pane must not be retargeted to a copy by an
 * editor's Save As: the shell runs its own copy flow instead. The editors share
 * one process with the shell, so the shell registers an interceptor once and
 * each editor asks it before showing its Save As dialog. The interceptor
 * returns true when it took over (or refused) the request.
 */
type SaveAsInterceptor = (webContentsId: number) => boolean

let interceptor: SaveAsInterceptor | null = null

export function setSaveAsInterceptor(fn: SaveAsInterceptor | null): void {
  interceptor = fn
}

/** true when the shell handled this Save As; the editor then shows nothing and writes nothing */
export function interceptSaveAs(webContentsId: number): boolean {
  if (!interceptor) return false
  try {
    return interceptor(webContentsId)
  } catch {
    return false
  }
}
