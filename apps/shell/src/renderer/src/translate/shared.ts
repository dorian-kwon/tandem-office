import type { Params } from '@genoffice/i18n'
import type { Lang } from '@genoffice/i18n'
import { parseTranslateError, type TranslateErrorCode } from '../../../shared/translate-api'
import { translateText, type TranslateStringKey } from '../i18n/strings-translate'

const ERROR_KEYS: Record<TranslateErrorCode, TranslateStringKey> = {
  PROJECT_EXISTS: 'errProjectExists',
  INVALID_PROJECT_NAME: 'errInvalidName',
  NOT_LISTED: 'errNotListed',
  NOT_A_PROJECT: 'errNotAProject',
  UNSUPPORTED_SOURCE: 'errUnsupportedSource',
  NOT_REGISTERED: 'errNotRegistered',
  INVALID_ARGUMENT: 'errInvalidArgument',
  PROJECT_FILE_INVALID: 'errProjectFileInvalid',
  UNKNOWN: 'errUnknown',
}

/** The localized message for a failed bridge call; never the raw Electron text. */
export function translateErrorText(lang: Lang, err: unknown): string {
  return translateText(lang, ERROR_KEYS[parseTranslateError(err).code])
}

export function makeText(lang: Lang) {
  return (key: TranslateStringKey, params?: Params) => translateText(lang, key, params)
}

/** Display name of a language code in the screen language. */
export function languageName(lang: Lang, code: string): string {
  try {
    return new Intl.DisplayNames([lang], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}
