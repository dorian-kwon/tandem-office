import type { Lang } from '@genoffice/i18n'
import type { TranslateApi, TranslateExportArgs } from '../../../shared/translate-api'
import { translateText } from '../i18n/strings-translate'
import { translateErrorText } from './shared'

export interface ExportNotice {
  text: string
  isError: boolean
}

/**
 * Run "Export translation" through the bridge and say what happened in the screen language.
 * Null when the person cancelled the save dialog (nothing to report).
 */
export async function exportNoticeFor(
  lang: Lang,
  api: Pick<TranslateApi, 'exportTranslation'>,
  args: TranslateExportArgs,
): Promise<ExportNotice | null> {
  try {
    const result = await api.exportTranslation(args)
    if (result.status === 'canceled') return null
    if (result.status === 'unsaved')
      return { text: translateText(lang, 'exportUnsaved'), isError: true }
    return { text: translateText(lang, 'exportDone'), isError: false }
  } catch (err) {
    return { text: translateErrorText(lang, err), isError: true }
  }
}
