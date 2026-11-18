import { aiEditUndoHistoryEnabled } from '@genoffice/ui'

/** Record at the commit, after validation; never keep a scope open during async work. */
export function recordEditHistory(aiEdit: boolean, record: () => void, skip: () => void): void {
  if (aiEdit && !aiEditUndoHistoryEnabled()) skip()
  else record()
}
