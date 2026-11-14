import {
  applyCellEditsToXlsx,
  readBasicWorkbook,
} from '../../../../../packages/xlsx-gateway/src/gateway/xlsx-gateway'
import { loadDocxZip } from '../../../../../packages/docx-engine/src/zip-load'
import type { OcrPlacement } from '../../shared/translate-ocr'
import { TranslateIpcError } from '../../shared/translate-api'
import { checkOcrBoxesPayload, type OcrBox } from '../../shared/ocr-boxes'
import { buildImageBoxParagraphsXml, inspectBoxableImage, nextDocPrId } from './ocr-boxes-docx'
import { placeInWordTable, wordTables } from './ocr-word-tables'
import { xlsxStructure } from './ocr-xlsx-structure'
export interface OcrTextItem {
  index: number
  text: string
  location?: string
  /** the package part and relationship id of an embedded picture (main process only) */
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

export async function ocrSheetNames(bytes: Uint8Array): Promise<string[]> {
  return (await readBasicWorkbook(Buffer.from(bytes))).snapshot.sheets.map((s) => s.name)
}

export async function ocrWordTables(bytes: Uint8Array) {
  const zip = await loadDocxZip(bytes)
  return wordTables(await zip.file('word/document.xml')!.async('string'))
}

/** Apply only the placement the person selected, preserving the source package and media. */
export async function placeOcrText(
  bytes: Uint8Array,
  format: 'xlsx' | 'docx',
  items: OcrTextItem[],
  choice: unknown,
): Promise<Uint8Array> {
  if (!choice || typeof choice !== 'object') invalid('choose where the OCR text goes')
  const p = choice as OcrPlacement
  if (format === 'xlsx') {
    if (p.kind !== 'xlsx-cells' && p.kind !== 'xlsx-new-sheet')
      invalid('choose an Excel destination')
    if (typeof p.sheet !== 'string' || !p.sheet.trim()) invalid('choose a sheet')
    const source = Buffer.from(bytes)
    const structure = await xlsxStructure(source)
    const names = structure.sheets.map((s) => s.name)
    let row = 0,
      column = 0
    if (p.kind === 'xlsx-cells') {
      const match =
        typeof p.cell === 'string' ? p.cell.toUpperCase().match(/^([A-Z]{1,3})([1-9]\d*)$/) : null
      if (!match || !names.includes(p.sheet) || typeof p.overwrite !== 'boolean')
        invalid('choose a valid sheet and cell')
      for (const ch of match![1]!) column = column * 26 + ch.charCodeAt(0) - 64
      column--
      row = Number(match![2]) - 1
      if (column >= 16384 || row + items.length > 1048576)
        invalid('the destination exceeds the sheet grid')
    } else if (
      names.some((n) => n.toLowerCase() === p.sheet.toLowerCase()) ||
      p.sheet.length > 31 ||
      ['\\', '/', '?', '*', '[', ']', ':'].some((char) => p.sheet.includes(char)) ||
      p.sheet.startsWith("'") ||
      p.sheet.endsWith("'")
    )
      invalid('choose a new sheet name')
    const selected = structure.sheets.find((s) => s.name === p.sheet)
    const edits = items.map((item, i) => {
      let n = column + 1,
        letters = ''
      while (n > 0) {
        letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters
        n = Math.floor((n - 1) / 26)
      }
      const existing = selected?.cells[`${letters}${row + i + 1}`]
      if (structure.isFollower(p.sheet, row + i, column))
        invalid('choose the first cell of a merged range')
      if (item.text.length > 32767) invalid('OCR text exceeds the Excel cell text limit')
      if (
        p.kind === 'xlsx-cells' &&
        !p.overwrite &&
        existing &&
        (existing.formula || (existing.value !== null && existing.value !== ''))
      )
        invalid('the destination has content; allow replacement or choose empty cells')
      return {
        sheetName: p.sheet,
        row: row + i,
        column,
        writeValue: true,
        cell: { value: item.text },
      }
    })
    const plan =
      p.kind === 'xlsx-new-sheet'
        ? { renames: [], removals: [], additions: [{ name: p.sheet }], order: [...names, p.sheet] }
        : undefined
    return (await applyCellEditsToXlsx(source, edits, [], [], plan)).buffer
  }
  if (
    p.kind !== 'docx-end' &&
    p.kind !== 'docx-after-images' &&
    p.kind !== 'docx-image-boxes' &&
    p.kind !== 'docx-table-cell'
  )
    invalid('choose a Word destination')
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
  const zip = await loadDocxZip(bytes)
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
          ? inspectBoxableImage(documentPart, documentSource, index, item.relId)
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
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}
