import { parseFileToText } from '@genoffice/file-parse'
import { convertReferenceToMarkdown, type ReferenceConversion } from '@genoffice/translate-project'

/**
 * A translation project's reference file as markdown for its keyword index:
 * read through `parseFileToText`, the path every cross-file read of the app
 * takes (so a span an editor withholds from the AI is a `{{label}}` here too),
 * then judged by `convertReferenceToMarkdown`. No OCR runs here: a picture or
 * a PDF without a text layer answers `needs-ocr`. Never throws.
 */
export function convertReference(path: string): Promise<ReferenceConversion> {
  return convertReferenceToMarkdown(path, (file) => parseFileToText(file))
}
