import type { AiReadPagePayload } from '../../../../../packages/pdf-structure/src/ai-read/content'
import type JSZip from 'jszip'
import { loadDocxZip } from '../../../../../packages/docx-engine/src/zip-load'
import type { OcrPlacement } from '../../shared/translate-ocr'
import { TranslateIpcError } from '../../shared/translate-api'
import { checkOcrBoxesPayload, type OcrBox } from '../../shared/ocr-boxes'
import { buildImageBoxParagraphsXml, inspectBoxableImage, nextDocPrId } from './ocr-boxes-docx'
import { placeInWordTable } from './ocr-word-tables'
import { replaceWordPictures } from '../ocr-word-replace'
import { wordPictureReferences } from './ocr-docx-pictures'

/**
 * OCR text into a Word document. Nothing here needs Node: the main process uses it to write a new
 * document, and the editor window uses it on the bytes of the document that is open.
 */

export interface OcrTextItem {
  index: number
  text: string
  form?: AiReadPagePayload
  location?: string
  /** the package part and relationship id of an embedded picture */
  part?: string
  relId?: string
}

function invalid(message: string): never {
  throw new TranslateIpcError('INVALID_ARGUMENT', message)
}
const escape = (s: string) =>
  Array.from(s)
    .filter((char) => char.charCodeAt(0) >= 32 || char === '\n' || char === '\r' || char === '\t')
    .join('')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

/** First live use of each relationship in this part, in the listing's paragraph coordinates. */
export function locatePictures(xml: string): Map<string, number> {
  const found = new Map<string, number>()
  for (const { relId, paragraph } of wordPictureReferences(xml)) {
    if (!found.has(relId)) found.set(relId, paragraph)
  }
  return found
}

const WORD_KINDS = [
  'docx-end',
  'docx-after-images',
  'docx-before-images',
  'docx-next-page',
  'docx-replace-images',
  'docx-image-boxes',
  'docx-table-cell',
]

/**
 * The Word placement the person chose, checked against the pictures that were read: a known kind,
 * and for boxes only pictures that were read, with boxes inside the picture.
 */
export function checkWordPlacement(
  items: OcrTextItem[],
  choice: unknown,
): { placement: OcrPlacement; boxesOf: Map<number, OcrBox[]> } {
  if (!choice || typeof choice !== 'object') invalid('choose where the OCR text goes')
  const p = choice as OcrPlacement
  if (!WORD_KINDS.includes(p.kind)) invalid('choose a Word destination')
  // boxes per picture, checked again here: only pictures that were read, inside the picture
  const boxesOf = new Map<number, OcrBox[]>()
  if (p.kind === 'docx-image-boxes') {
    if (!Array.isArray(p.images)) invalid('choose the boxes to place')
    const known = new Set(items.map((item) => item.index))
    for (const image of p.images) {
      if (!image || !known.has(image.index) || boxesOf.has(image.index))
        invalid('a box list is for a picture that was not read')
      const checked = checkOcrBoxesPayload({ kind: 'boxes', boxes: image.boxes, text: '' })
      if (!checked || checked.boxes.length === 0)
        invalid('a picture needs between one and the allowed number of boxes inside it')
      boxesOf.set(image.index, checked!.boxes)
    }
  }
  return { placement: p, boxesOf }
}

/** A page break belongs in the main page flow. For pictures in a text box or a
 * nested table, move past its enclosing drawing paragraph/table before starting the page. */
function insertAtPictureParagraphs(
  xml: string,
  positions: ReadonlyMap<number, string>,
  kind: OcrPlacement['kind'],
): string {
  type Span = { start: number; end: number }
  const stack: Span[] = []
  const insertions: { span: Span; text: string }[] = []
  let paragraph = 0
  const tags =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)w:(p|tbl)(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>/g
  for (const tag of xml.matchAll(tags)) {
    if (!tag[2]) continue
    const end = tag.index + tag[0].length
    if (tag[1]) {
      const span = stack.pop()
      if (span) span.end = end
      continue
    }
    const span = { start: tag.index, end }
    if (tag[2] === 'p') {
      const text = positions.get(++paragraph)
      if (text !== undefined)
        insertions.push({ text, span: kind === 'docx-next-page' ? (stack[0] ?? span) : span })
    }
    if (!tag[0].endsWith('/>')) stack.push(span)
  }
  if (insertions.length !== positions.size) invalid('the destination paragraph is missing')
  const byOffset = new Map<number, string[]>()
  for (const entry of insertions) {
    const at = kind === 'docx-before-images' ? entry.span.start : entry.span.end
    const group = byOffset.get(at) ?? []
    group.push(entry.text)
    byOffset.set(at, group)
  }
  const chunks: string[] = []
  let cursor = 0
  for (const [at, group] of [...byOffset].sort(([a], [b]) => a - b)) {
    chunks.push(xml.slice(cursor, at))
    if (kind === 'docx-next-page') chunks.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>')
    chunks.push(...group)
    if (group.at(-1)?.endsWith('</w:tbl>') && /^\s*<\/w:tc>/.test(xml.slice(at)))
      chunks.push('<w:p/>')
    cursor = at
  }
  return chunks.join('') + xml.slice(cursor)
}

/** Apply only the placement the person selected, preserving the source package and media. */
async function placeInZip(zip: JSZip, items: OcrTextItem[], choice: unknown): Promise<void> {
  const { placement: p, boxesOf } = checkWordPlacement(items, choice)
  const paragraph = (text: string, pPr = '', rPr = '') =>
    text
      .split(/\r?\n/)
      .map(
        (line) =>
          `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${escape(line)}</w:t></w:r></w:p>`,
      )
      .join('')
  const content = async (item: OcrTextItem) => {
    if (item.form) {
      const { ocrWordFormXml } = await import('./ocr-word-form')
      const blocks = ocrWordFormXml(item.form, paragraph)
      if (blocks) return blocks
    }
    return paragraph(item.text)
  }
  if (p.kind === 'docx-replace-images') {
    const byPart = new Map<string, Map<string, OcrTextItem>>()
    for (const item of items) {
      const at = item.location?.match(/ · ¶(\d+)$/)?.[1]
      if (!item.part || !item.relId || !at) invalid('the destination picture is missing')
      const entries = byPart.get(item.part) ?? new Map<string, OcrTextItem>()
      entries.set(at + ':' + item.relId, item)
      byPart.set(item.part, entries)
    }
    for (const [part, entries] of byPart) {
      const xml = await zip.file(part)?.async('string')
      if (!xml) invalid('the destination part is missing')
      const targets = new Map<number, string>()
      for (const ref of wordPictureReferences(xml)) {
        const key = ref.paragraph + ':' + ref.relId
        if (entries.has(key)) targets.set(ref.offset, key)
      }
      const replaced = new Set<string>()
      const next = await replaceWordPictures(
        xml,
        targets,
        async (key) => {
          const item = entries.get(key)!
          if (!item.text.trim()) return null
          replaced.add(key)
          return content(item)
        },
        () => false,
      )
      if (replaced.size !== entries.size)
        invalid('One or more pictures could not be replaced. Choose a different placement.')
      zip.file(part, next)
    }
    return
  }
  const additions = new Map<string, Map<number, string>>()
  if (
    p.kind === 'docx-after-images' ||
    p.kind === 'docx-before-images' ||
    p.kind === 'docx-next-page' ||
    p.kind === 'docx-image-boxes'
  ) {
    const documentPart = 'word/document.xml'
    const documentSource = await zip.file(documentPart)?.async('string')
    const stylesSource = await zip.file('word/styles.xml')?.async('string')
    let docPrId = documentSource ? nextDocPrId(documentSource) : 1
    for (const item of items) {
      const at = item.location?.match(
        /^((?:document|header\d*|footer\d*|footnotes|endnotes)\.xml) · ¶(\d+)$/,
      )
      if (!at) invalid('the image paragraph is not available')
      const part = 'word/' + at![1]
      if (item.part && item.part !== part)
        invalid('the source picture and its destination part differ')
      if (p.kind === 'docx-next-page' && part !== documentPart)
        invalid('a next-page destination requires a picture in the document body')
      const positions = additions.get(part) ?? new Map<number, string>()
      const index = Number(at![2])
      // boxes only where this picture can take them; every other picture keeps its text paragraph
      const boxes = boxesOf.get(item.index)
      const info =
        boxes && documentSource && item.part === documentPart && item.relId
          ? inspectBoxableImage(documentPart, documentSource, index, item.relId, stylesSource)
          : null
      let insertion: string
      if (boxes && info?.ok) {
        insertion = buildImageBoxParagraphsXml(boxes, info, docPrId)
        docPrId += boxes.length
      } else insertion = p.kind === 'docx-image-boxes' ? paragraph(item.text) : await content(item)
      positions.set(index, (positions.get(index) ?? '') + insertion)
      additions.set(part, positions)
    }
    for (const [part, positions] of additions) {
      const file = zip.file(part)
      if (!file) invalid('the destination part is missing')
      const xml = await file!.async('string')
      if (p.kind === 'docx-before-images' || p.kind === 'docx-next-page') {
        const refs = new Map<number, Set<string>>()
        for (const { paragraph, relId } of wordPictureReferences(xml)) {
          const relations = refs.get(paragraph) ?? new Set<string>()
          relations.add(relId)
          refs.set(paragraph, relations)
        }
        for (const item of items) {
          const [sourcePart, ordinal] = item.location!.split(' · ¶')
          if (part !== 'word/' + sourcePart) continue
          const relations = refs.get(Number(ordinal))
          if (!relations?.size || (item.relId && !relations.has(item.relId)))
            invalid('the source picture is missing from its paragraph')
        }
      }
      const out = insertAtPictureParagraphs(xml, positions, p.kind)
      zip.file(part, out)
    }
  } else if (p.kind === 'docx-table-cell') {
    const file = zip.file('word/document.xml')
    if (!file) invalid('the document body is missing')
    zip.file(
      'word/document.xml',
      placeInWordTable(
        await file.async('string'),
        p.table,
        p.row,
        p.column,
        items.map((i) => i.text),
        p.overwrite,
        paragraph,
      ),
    )
  } else {
    const file = zip.file('word/document.xml')
    if (!file) invalid('the document body is missing')
    const xml = await file!.async('string')
    const body = xml.lastIndexOf('</w:body>')
    if (body < 0) invalid('the document body is missing')
    const section = xml.lastIndexOf('<w:sectPr')
    const at =
      section >= 0 &&
      /^<w:sectPr\b[^>]*(?:\/>|>[\s\S]*<\/w:sectPr>)\s*$/.test(xml.slice(section, body))
        ? section
        : body
    zip.file(
      'word/document.xml',
      xml.slice(0, at) + items.map((i) => paragraph(i.text)).join('') + xml.slice(at),
    )
  }
}

/** The OCR text into the bytes of a Word document, as a new document. */
export async function placeOcrTextInDocx(
  bytes: Uint8Array,
  items: OcrTextItem[],
  choice: unknown,
): Promise<Uint8Array> {
  const zip = await loadDocxZip(bytes)
  await placeInZip(zip, items, choice)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

/**
 * The OCR text into the bytes of the document that is open. The pictures were listed from a copy
 * and the open document may have changed since, so each picture is found again by its
 * relationship id and the paragraph number of the listing is not trusted. A picture that is no
 * longer there is left out and reported. A table destination is refused: its table, row and
 * column were chosen on the copy.
 */
export async function placeOcrIntoOpenDocx(
  bytes: Uint8Array,
  items: OcrTextItem[],
  choice: unknown,
): Promise<{ bytes: Uint8Array; placed: number[]; skipped: number[] }> {
  if (!choice || typeof choice !== 'object') invalid('choose where the OCR text goes')
  const p = choice as OcrPlacement
  if (p.kind === 'docx-table-cell')
    invalid('a table destination cannot be placed into a document that may have changed')
  if (!WORD_KINDS.includes(p.kind)) invalid('choose a Word destination')
  const zip = await loadDocxZip(bytes)
  if (p.kind === 'docx-end') {
    await placeInZip(zip, items, p)
    return {
      bytes: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }),
      placed: items.map((i) => i.index),
      skipped: [],
    }
  }
  const located = new Map<string, Map<string, Set<number>>>()
  const found: OcrTextItem[] = []
  const skipped: number[] = []
  for (const item of items) {
    let at: number | undefined
    if (item.part && item.relId) {
      if (!located.has(item.part)) {
        const xml = await zip.file(item.part)?.async('string')
        const coordinates = new Map<string, Set<number>>()
        if (xml)
          for (const ref of wordPictureReferences(xml)) {
            const positions = coordinates.get(ref.relId) ?? new Set<number>()
            positions.add(ref.paragraph)
            coordinates.set(ref.relId, positions)
          }
        located.set(item.part, coordinates)
      }
      const candidates = located.get(item.part)!.get(item.relId)
      const listed = Number(item.location?.match(/ · ¶(\d+)$/)?.[1])
      if (candidates?.has(listed)) at = listed
      else if (candidates?.size === 1) at = candidates.values().next().value
    }
    if (at === undefined) skipped.push(item.index)
    else found.push({ ...item, location: `${item.part!.replace(/^word\//, '')} · ¶${at}` })
  }
  if (found.length === 0) invalid('no picture of this reading is left in the document')
  const keep = new Set(found.map((item) => item.index))
  const narrowed: OcrPlacement =
    p.kind === 'docx-image-boxes'
      ? { kind: 'docx-image-boxes', images: p.images.filter((image) => keep.has(image.index)) }
      : p
  await placeInZip(zip, found, narrowed)
  return {
    bytes: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }),
    placed: found.map((item) => item.index),
    skipped,
  }
}
