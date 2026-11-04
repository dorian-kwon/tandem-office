/**
 * The AI dock under the shell's split panes (decision 0036): while this view is
 * the secondary pane its panel is forced to the collapsed rail, and a click on
 * that rail asks the shell to focus this pane first, so the panel it opens is
 * the visible one. Without the bridge (a standalone editor) nothing changes.
 */
import { useTranslationAiDock, type TranslationPaneKind } from '@genoffice/ui'

export interface AiDockState {
  /** what the dock renders: a secondary pane's panel is forced to the rail */
  open: boolean
  /** a click on the collapsed rail: focus this pane first where the shell split it */
  onExpand: () => void
  /** source: panel starts closed, opens only on a press; output: kept open on blur */
  paneKind: TranslationPaneKind
}

export function useAiDock(
  localOpen: boolean,
  setLocalOpen: (open: boolean) => void,
): AiDockState {
  return useTranslationAiDock(localOpen, setLocalOpen, {
    isSource: () => window.desktopApi?.isTranslationSource?.() ?? Promise.resolve(false),
    isOutput: () => window.desktopApi?.isTranslationOutput?.() ?? Promise.resolve(false),
  })
}
