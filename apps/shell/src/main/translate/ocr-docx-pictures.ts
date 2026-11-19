import { decodeEntities } from '../../../../../packages/docx-engine/src/parse-xml-text'

/** Word paragraph numbers are shared by OCR selection, placement and live document edits.
 * A drawing can contain DrawingML paragraphs or a text box inside another Word paragraph.
 * The picture after a text box still belongs to its enclosing Word paragraph. */
export function* wordPictureReferences(xml: string) {
  const paragraphs: number[] = []
  let ordinal = 0
  let objectDepth = 0
  const tags =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)(w:p|(?:[\w-]+:)?(?:object|blip|imagedata|fill))(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>/g
  for (const tag of xml.matchAll(tags)) {
    const name = tag[2]
    if (!name) continue
    const closing = tag[1] === '/'
    const empty = tag[0].endsWith('/>')
    if (name === 'w:p') {
      if (closing) paragraphs.pop()
      else {
        ordinal++
        if (!empty) paragraphs.push(ordinal)
      }
      continue
    }
    const kind = name.slice(name.lastIndexOf(':') + 1)
    if (kind === 'object') {
      if (closing) objectDepth = Math.max(0, objectDepth - 1)
      else if (!empty) objectDepth++
      continue
    }
    if (closing || objectDepth) continue
    const reference = /\sr:(?:embed|id)\s*=\s*(?:"([^"]+)"|'([^']+)')/.exec(tag[0])
    if (reference) {
      yield {
        relId: decodeEntities(reference[1] ?? reference[2]!),
        paragraph: paragraphs.at(-1) ?? Math.max(1, ordinal),
        kind,
        offset: tag.index,
      }
    }
  }
}
