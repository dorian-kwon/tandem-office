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
  SOURCE_MISSING: 'errSourceMissing',
  SOURCE_NOT_EDITABLE: 'errSourceNotEditable',
  OPEN_FAILED: 'errOpenFailed',
  OCR_DISABLED: 'errOcrDisabled',
  EMPTY_SELECTION: 'errOcrEmpty',
  OCR_CANCELLED: 'errOcrCancelled',
  OCR_BUSY: 'errOcrBusy',
  OCR_EXPIRED: 'errOcrExpired',
  OCR_FAILED: 'errOcrFailed',
  UNSUPPORTED_LANGUAGE: 'errUnsupportedLanguage',
  TRANSLATE_BUSY: 'errTranslateBusy',
  TRANSLATE_EXPIRED: 'errTranslateExpired',
  TRANSLATE_FAILED: 'errTranslateFailed',
  SOURCE_CHANGED: 'errSourceChanged',
  PROJECT_IN_USE: 'errProjectInUse',
  GLOSSARY_INVALID: 'errGlossaryInvalid',
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
