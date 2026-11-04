import type { Lang } from '@genoffice/i18n'
import type { TranslateApi, TranslateExportArgs } from '../../../shared/translate-api'
import { translateText } from '../i18n/strings-translate'
import { translateErrorText } from './shared'

export interface SaveAsNotice {
  text: string
  isError: boolean
}

/**
 * Run "Save as…" through the bridge and say what happened in the screen language.
 * Null when the person cancelled the save dialog (nothing to report).
 */
export async function saveAsNoticeFor(
  lang: Lang,
  api: Pick<TranslateApi, 'exportTranslation'>,
  args: TranslateExportArgs,
): Promise<SaveAsNotice | null> {
  try {
    const result = await api.exportTranslation(args)
    if (result.status === 'canceled') return null
    if (result.status === 'unsaved')
      return { text: translateText(lang, 'saveAsUnsaved'), isError: true }
    return { text: translateText(lang, 'saveAsDone'), isError: false }
  } catch (err) {
    return { text: translateErrorText(lang, err), isError: true }
  }
}
