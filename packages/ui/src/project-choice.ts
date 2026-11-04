import type { ChoiceRememberHost } from './use-ai-choice'
import type { ProjectRun } from './project-skill'

/**
 * The answers a translation project can keep (the same keys as `TRANSLATION_CHOICE_KEYS` in
 * the translate-project package; a shell test keeps the two lists equal).
 */
export const CHOICE_REMEMBER_KEYS: readonly string[] = ['outputMode', 'bilingual', 'ocrPlacement']

/**
 * The "use this for the rest of the project" host of an editor's AI panel. The checkbox shows
 * only for a key the project can keep, when the panel's last request carried a translation
 * project, and when the preload bridge has the call. Elsewhere the question simply has no
 * checkbox. Main takes the project from the calling window; a refusal is ignored (the answer
 * still reached the AI as the next message).
 */
export function projectChoiceRemember(
  readRun: () => ProjectRun | null | undefined,
): ChoiceRememberHost {
  // The panels declare their project hook after the choice hook, so a read during that first
  // render touches a binding that is not initialised yet (a ReferenceError that blanks the
  // whole screen). Treat it as "no project run yet"; the next render reads it normally.
  const getRun = (): ProjectRun | null | undefined => {
    try {
      return readRun()
    } catch {
      return null
    }
  }
  return {
    can: (key) => {
      const run = getRun()
      return (
        CHOICE_REMEMBER_KEYS.includes(key) &&
        run?.translationProject === true &&
        typeof run.bridge.rememberChoice === 'function'
      )
    },
    store: (key, answer) => {
      const call = getRun()?.bridge.rememberChoice
      if (typeof call !== 'function') return
      const run = getRun()
      if (!run) return
      void call.call(run.bridge, { key, value: answer.text }).catch(() => undefined)
    },
  }
}
