import type JSZip from 'jszip'
import { loadDocxZip } from '../../../../../packages/docx-engine/src/zip-load'
import type { OcrPlacement } from '../../shared/translate-ocr'
import { TranslateIpcError } from '../../shared/translate-api'
import { checkOcrBoxesPayload, type OcrBox } from '../../shared/ocr-boxes'
import { buildImageBoxParagraphsXml, inspectBoxableImage, nextDocPrId } from './ocr-boxes-docx'
import { placeInWordTable } from './ocr-word-tables'

/**
 * OCR text into a Word document. Nothing here needs Node: the main process uses it to write a new
 * document, and the editor window uses it on the bytes of the document that is open.
 */

export interface OcrTextItem {
  index: number
  text: string
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

const RELATION_ID = /\br:(?:embed|id)\s*=\s*(?:"([^"]*)"|'([^']*)')/

/**
 * The paragraph number of the first place each relationship id is used, counted the way the
 * picture listing counts (`<w:p>`, `blip`, `imagedata` and `fill` in order, objects left out). The
 * number is only good for the XML it was counted in.
 */
export function locatePictures(xml: string): Map<string, number> {
  const stripped = xml.replace(/<(?:\w+:)?object\b[\s\S]*?<\/(?:\w+:)?object\s*>/g, '')
  const found = new Map<string, number>()
  let paragraph = 0
  for (const m of stripped.matchAll(/<(?:\w+:)?(p|blip|imagedata|fill)\b[^>]*>/g)) {
    if (m[1] === 'p') {
      paragraph++
      continue
    }
    const id = RELATION_ID.exec(m[0])
    const relId = id?.[1] ?? id?.[2]
    if (relId && !found.has(relId)) found.set(relId, Math.max(1, paragraph))
  }
  return found
}

const WORD_KINDS = ['docx-end', 'docx-after-images', 'docx-image-boxes', 'docx-table-cell']

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
  const additions = new Map<string, Map<number, string>>()
  if (p.kind === 'docx-after-images' || p.kind === 'docx-image-boxes') {
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
      } else insertion = paragraph(item.text)
      positions.set(index, (positions.get(index) ?? '') + insertion)
      additions.set(part, positions)
    }
    for (const [part, positions] of additions) {
      const file = zip.file(part)
      if (!file) invalid('the destination part is missing')
      const xml = await file!.async('string')
      let count = 0
      const stack: number[] = []
      const insertions: { end: number; text: string }[] = []
      for (const tag of xml.matchAll(/<\/?w:p\b[^>]*>/g)) {
        if (tag[0].startsWith('</')) {
          const number = stack.pop()
          if (number && positions.has(number)) {
            insertions.push({ end: tag.index! + tag[0].length, text: positions.get(number)! })
            positions.delete(number)
          }
        } else {
          const number = ++count
          if (tag[0].endsWith('/>')) {
            if (positions.has(number)) {
              insertions.push({ end: tag.index! + tag[0].length, text: positions.get(number)! })
              positions.delete(number)
            }
          } else stack.push(number)
        }
      }
      if (positions.size) invalid('the destination paragraph is missing')
      let out = xml
      for (const i of insertions.sort((a, b) => b.end - a.end))
        out = out.slice(0, i.end) + i.text + out.slice(i.end)
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
  const located = new Map<string, Map<string, number>>()
  const found: OcrTextItem[] = []
  const skipped: number[] = []
  for (const item of items) {
    let at: number | undefined
    if (item.part && item.relId) {
      if (!located.has(item.part)) {
        const xml = await zip.file(item.part)?.async('string')
        located.set(item.part, xml ? locatePictures(xml) : new Map())
      }
      at = located.get(item.part)!.get(item.relId)
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
