import { useCallback, useEffect, useRef, useState } from 'react'

/** What a pane is for; "no role" (standalone editor, no split) is null. */
export type SplitPaneRole = 'focus' | 'secondary'

/**
 * The split-pane calls an editor's preload exposes as window.aiOfficeSplit.
 * Declared locally on purpose: this package reads the bridge off the window
 * and must not depend on the preload-side package (@genoffice/electron-utils)
 * that builds it.
 */
export interface SplitPaneBridge {
  /** the role the shell gave this view, or null when it is not in a split */
  getRole(): Promise<SplitPaneRole | null>
  /** a new role whenever the split changes; returns the unsubscribe */
  onRoleChanged(handler: (role: SplitPaneRole | null) => void): () => void
  /** ask the shell to move focus to this pane */
  requestFocus(): void
  /** fallback ping: this view gained focus */
  reportFocus(): void
}

/** Key of the bridge an editor's preload exposes on its window object. */
export const SPLIT_PANE_BRIDGE_KEY = 'aiOfficeSplit'

function splitPaneBridge(): SplitPaneBridge | null {
  const b = (globalThis as { aiOfficeSplit?: Partial<SplitPaneBridge> }).aiOfficeSplit
  return typeof b?.getRole === 'function' &&
    typeof b.onRoleChanged === 'function' &&
    typeof b.requestFocus === 'function' &&
    typeof b.reportFocus === 'function'
    ? (b as SplitPaneBridge)
    : null
}

/** The role read and the way to ask for focus, as an AI panel's dock needs them. */
export interface SplitPaneRoleController {
  role: SplitPaneRole | null
  requestFocus: () => void
}

/**
 * The role the shell gave this view's pane: read once through the bridge and
 * then kept current by its change notifications. Without the bridge (a
 * standalone editor, or a dev run) the role stays null and no panel is forced
 * shut, so an editor opts into the split behaviour just by gaining the bridge.
 */
export function useSplitPaneRole(): SplitPaneRoleController {
  const [role, setRole] = useState<SplitPaneRole | null>(null)

  useEffect(() => {
    const bridge = splitPaneBridge()
    if (!bridge) return
    let live = true
    // A change notification is always fresher than the one-shot read: once one
    // has arrived, the read's late answer must not overwrite it.
    let pushed = false
    void bridge
      .getRole()
      .then((next) => {
        if (live && !pushed) setRole(next ?? null)
      })
      .catch(() => {})
    const off = bridge.onRoleChanged((next) => {
      if (!live) return
      pushed = true
      setRole(next ?? null)
    })
    return () => {
      live = false
      off()
    }
  }, [])

  const requestFocus = useCallback(() => {
    splitPaneBridge()?.requestFocus()
  }, [])

  return { role, requestFocus }
}

/**
 * Fallback focus reporting: call once at a screen root and the shell is told
 * whenever this window gains focus, even where pane view focus events are not
 * delivered. Sending the ping repeatedly is safe on its own.
 */
export function useSplitPaneFocusPing(): void {
  useEffect(() => {
    const bridge = splitPaneBridge()
    if (!bridge) return
    const ping = () => bridge.reportFocus()
    window.addEventListener('focus', ping)
    return () => window.removeEventListener('focus', ping)
  }, [])
}

/**
 * Whether an AI panel is shown: a secondary pane's panel is always forced to
 * the rail so only the focus pane's panel is out; everywhere else the panel's
 * own open state stands.
 */
export function effectiveAiPanelOpen(
  localOpen: boolean,
  role: SplitPaneRole | null,
  kind: TranslationPaneKind = null,
): boolean {
  // the translation output keeps its panel through a focus switch to the source
  if (kind === 'output') return localOpen
  return role === 'secondary' ? false : localOpen
}

/** Which half of the translation view this window is; null outside one. */
export type TranslationPaneKind = 'source' | 'output' | null

/** The shell questions an editor's preload exposes for the translation view. */
export interface TranslationPaneProbes {
  readonly isSource?: (() => Promise<boolean>) | undefined
  readonly isOutput?: (() => Promise<boolean>) | undefined
}

/** Source wins over output; a failing or missing probe counts as "no". */
export async function probeTranslationPaneKind(
  probes: TranslationPaneProbes,
): Promise<TranslationPaneKind> {
  const ask = async (fn?: () => Promise<boolean>) => {
    try {
      return fn ? (await fn()) === true : false
    } catch {
      return false
    }
  }
  if (await ask(probes.isSource)) return 'source'
  if (await ask(probes.isOutput)) return 'output'
  return null
}

/**
 * The AI dock for editors that can sit in the translation view. Source pane:
 * its panel starts closed and never opens from focus alone, only from a press
 * on the AI button or rail. Output pane: its panel is not forced to the rail
 * when the source has focus. Both are re-probed whenever the split role changes.
 */
export function useTranslationAiDock(
  localOpen: boolean,
  setLocalOpen: (open: boolean) => void,
  probes: TranslationPaneProbes,
): { open: boolean; onExpand: () => void; paneKind: TranslationPaneKind } {
  const { role, requestFocus } = useSplitPaneRole()
  const [paneKind, setPaneKind] = useState<TranslationPaneKind>(null)
  const probesRef = useRef(probes)
  probesRef.current = probes
  useEffect(() => {
    if (role === null) {
      setPaneKind(null)
      return undefined
    }
    let live = true
    void probeTranslationPaneKind(probesRef.current).then((k) => {
      if (live) setPaneKind(k)
    })
    return () => {
      live = false
    }
  }, [role])
  const wasSource = useRef(false)
  useEffect(() => {
    if (paneKind === 'source' && !wasSource.current) setLocalOpen(false)
    wasSource.current = paneKind === 'source'
  }, [paneKind, setLocalOpen])
  return {
    open: effectiveAiPanelOpen(localOpen, role, paneKind),
    onExpand: () => onAiRailClick(role, localOpen, setLocalOpen, requestFocus),
    paneKind,
  }
}

/**
 * A click on the collapsed AI rail: in a secondary pane it asks the shell to
 * focus this pane and remembers the panel as open, so the panel appears once
 * focus arrives; everywhere else it toggles the panel as before.
 */
export function onAiRailClick(
  role: SplitPaneRole | null,
  localOpen: boolean,
  setLocalOpen: (open: boolean) => void,
  requestFocus: () => void,
): void {
  if (role === 'secondary') {
    requestFocus()
    setLocalOpen(true)
    return
  }
  setLocalOpen(!localOpen)
}
