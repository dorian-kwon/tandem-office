import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import type {
  RecentUpdateVersion,
  SelectUpdateVersionResult,
  UpdateUiState,
} from '../shared/update-api'
import { UPDATE_CHANNELS } from '../shared/update-api'

/**
 * The update window: a frameless card centered over the shell window —
 * non-modal since the settings entry landed, so it never blocks work; its
 * "minimize" action folds it away and Settings → About re-opens it on demand.
 * Content lives in renderer/update.html; this module owns the window
 * lifecycle, the pushed UI state, and the download / install / later IPC
 * surface, plus the settings-facing get-state / open-for-update entry — the
 * last two are registered at module load, since the shell window invokes them
 * before any update is known (see registerSettingsIpc).
 *
 * The card grows when the release notes are shown: the extra height fits the
 * notes box (max ~200px, scrolls) plus its label and footer link. Sizes are
 * tuned in docs/plans/update-details.md §5.
 */

interface UpdateActions {
  onDownload: () => void
  onInstall: () => void
  onLater: () => void
  onOpenDownload: () => void
  onListVersions?: () => Promise<RecentUpdateVersion[] | null>
  onSelectVersion?: (version: string) => Promise<SelectUpdateVersionResult>
}

const UPDATE_WINDOW_WIDTH = 400
const UPDATE_WINDOW_HEIGHT = 430
/** the same card with the release-notes box and its label/footer (~190px) */
const UPDATE_WINDOW_HEIGHT_WITH_NOTES = 620

let updateWin: BrowserWindow | null = null
let currentState: UpdateUiState | null = null
let actions: UpdateActions | null = null
let ipcRegistered = false
let parentGetter: () => BrowserWindow | null = () => null
/** fallback when no getter was registered (tests, direct callers) */
let lastParent: BrowserWindow | null = null
// distinguishes programmatic close (install/quit) from the user closing the
// window some other way (Alt+F4…), which counts as "later"
let closingProgrammatically = false

/** The shell window is recreated on macOS after close, so it is resolved per call, never cached. */
export function setUpdateParentWindow(getter: () => BrowserWindow | null): void {
  parentGetter = getter
}

/** Leave the renderer running while the update E2E uses CDP on macOS. */
export function hideUpdateTestWindows(): boolean {
  return (
    process.platform === 'darwin' &&
    process.env.GENOFFICE_TEST_HIDDEN_UPDATE_WINDOWS === '1' &&
    !app.isPackaged
  )
}

function revealUpdateWindow(win: BrowserWindow, inactive: boolean, focus: boolean): void {
  if (hideUpdateTestWindows()) return
  if (inactive) win.showInactive()
  else {
    win.show()
    if (focus) win.focus()
  }
}

function parentWindow(): BrowserWindow | null {
  const win = parentGetter() ?? lastParent
  return win && !win.isDestroyed() ? win : null
}

function broadcastState(): void {
  parentWindow()?.webContents.send(UPDATE_CHANNELS.stateChanged, currentState)
}

/**
 * The two channels the shell window invokes from Settings → About. That call
 * happens on mount — long before any update is known, which on a fresh launch
 * is every launch — so these cannot live behind showUpdateWindow: a handler
 * that only exists once the dialog has opened cannot answer the very first
 * invoke, and ipcRenderer.invoke rejects with "No handler registered".
 * currentState is null until the updater reports something, and null is the
 * answer ("no update known"), not an error, so module load is the right
 * registration point: this module is pulled in statically by updater.ts at
 * main-process start, long before any renderer exists.
 */
function registerSettingsIpc(): void {
  ipcMain.handle(UPDATE_CHANNELS.getState, () => currentState)
  // Settings → About "update to vX": surface the dialog again (it may have
  // been minimized) and, when nothing has started yet, start the download.
  // Returns false while no update is known — the settings button stays
  // hidden in that state, so callers treat it as a no-op.
  ipcMain.handle(UPDATE_CHANNELS.openForUpdate, (): boolean => {
    if (!currentState) return false
    if (updateWin && !updateWin.isDestroyed()) {
      revealUpdateWindow(updateWin, false, true)
    } else {
      const parent = parentWindow()
      if (parent) showUpdateWindow(parent, currentState, actions ?? dummyActions)
    }
    if (
      currentState.phase === 'available' ||
      currentState.phase === 'error' ||
      currentState.phase === 'install-failed'
    )
      actions?.onDownload()
    return true
  })
}
registerSettingsIpc()

/**
 * The dialog's own channels. They stay here: only renderer/update.html loads
 * preload/update.js, and that file exists solely because showUpdateWindow
 * created the window, so nothing can reach these handlers before then. Their
 * callbacks read `actions`, which is only assigned alongside that window.
 */
function registerIpc(): void {
  if (ipcRegistered) return
  ipcRegistered = true
  ipcMain.handle(UPDATE_CHANNELS.download, () => actions?.onDownload())
  ipcMain.handle(UPDATE_CHANNELS.install, () => actions?.onInstall())
  ipcMain.handle(UPDATE_CHANNELS.later, () => actions?.onLater())
  ipcMain.handle(UPDATE_CHANNELS.openDownload, () => actions?.onOpenDownload())
  // Only the update window can request a manually pinned release, and the main
  // process checks that the version appeared in its own catalog.
  ipcMain.handle(UPDATE_CHANNELS.listVersions, (event) =>
    event.sender === updateWin?.webContents ? (actions?.onListVersions?.() ?? null) : null,
  )
  ipcMain.handle(UPDATE_CHANNELS.selectVersion, (event, version: unknown) =>
    event.sender === updateWin?.webContents && typeof version === 'string'
      ? (actions?.onSelectVersion?.(version) ?? 'unavailable')
      : 'unavailable',
  )
}

/** keeps the handler total when actions are missing (cannot happen today) */
const dummyActions: UpdateActions = {
  onDownload: () => {},
  onInstall: () => {},
  onLater: () => {},
  onOpenDownload: () => {},
}

/** the freshest pushed state (null before the first update was ever seen) */
export function currentUpdateUiState(): UpdateUiState | null {
  return currentState
}

export function showUpdateWindow(
  parent: BrowserWindow | null,
  state: UpdateUiState,
  windowActions: UpdateActions,
  /** shown without taking the focus: the update came back by itself, not on a click */
  options: { inactive?: boolean } = {},
): void {
  const hadNotes = (currentState?.releaseNotes?.sections.length ?? 0) > 0
  const hasNotes = (state.releaseNotes?.sections.length ?? 0) > 0
  currentState = state
  actions = windowActions
  if (parent && !parent.isDestroyed()) lastParent = parent
  registerIpc()
  broadcastState()

  if (updateWin && !updateWin.isDestroyed()) {
    if (hadNotes !== hasNotes) {
      updateWin.setSize(
        UPDATE_WINDOW_WIDTH,
        hasNotes ? UPDATE_WINDOW_HEIGHT_WITH_NOTES : UPDATE_WINDOW_HEIGHT,
      )
    }
    updateWin.webContents.send(UPDATE_CHANNELS.changed, currentState)
    revealUpdateWindow(updateWin, options.inactive === true, true)
    return
  }

  const win = new BrowserWindow({
    width: UPDATE_WINDOW_WIDTH,
    height: hasNotes ? UPDATE_WINDOW_HEIGHT_WITH_NOTES : UPDATE_WINDOW_HEIGHT,
    ...(parent && !parent.isDestroyed() ? { parent } : {}),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: state.strings.title,
    webPreferences: {
      preload: join(__dirname, '../preload/update.js'),
      ...(hideUpdateTestWindows() ? { backgroundThrottling: false } : {}),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  updateWin = win

  win.once('ready-to-show', () => revealUpdateWindow(win, options.inactive === true, false))
  win.on('closed', () => {
    updateWin = null
    if (!closingProgrammatically) actions?.onLater()
    closingProgrammatically = false
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/update.html`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/update.html'))
  }
}

export function isUpdateWindowOpen(): boolean {
  return updateWin !== null && !updateWin.isDestroyed()
}

export function pushUpdateState(patch: Partial<UpdateUiState>): void {
  if (!currentState) return
  currentState = { ...currentState, ...patch }
  if (updateWin && !updateWin.isDestroyed()) {
    updateWin.webContents.send(UPDATE_CHANNELS.changed, currentState)
  }
  broadcastState()
}

/** Forget the known update (channel switch): About stops offering it and open-for-update answers false. */
export function clearUpdateState(): void {
  closeUpdateWindow()
  currentState = null
  broadcastState()
}

export function closeUpdateWindow(): void {
  if (updateWin && !updateWin.isDestroyed()) {
    closingProgrammatically = true
    updateWin.close()
  }
  updateWin = null
}
