import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { posix } from 'node:path'
import {
  parseRels,
  resolveMainDocumentPath,
  resolveRelationshipTargetPath,
} from '../../../../packages/docx-engine/src/parse-package'
import { escapeXmlText } from '../../../../packages/docx-engine/src/xml-utils'
import { loadDocxZip } from '../../../../packages/docx-engine/src/zip-load'
import {
  extractIrDocument,
  type ImageBlock,
  type IrPage,
  type OcrEngine,
  type PdfiumModule,
  type TableBlock,
  type TextBlock,
} from '../../../../packages/pdf2docx/src'
import { encodeRgbaPng } from '../../../../packages/pdf2docx/src/extract/png'
import { imagesToPdfBytes, readImageInfo } from '../../../pdf/src/main/images-to-pdf'
import { decodeBmpForJpeg, MAX_BMP_PIXELS } from './document-images/bmp'
import { recoveredWordArt } from './ocr-word-art'
import { replaceWordPictures } from './ocr-word-replace'
import { wordPictureReferences } from './translate/ocr-docx-pictures'

function textParagraph(block: TextBlock): string {
  const lines = block.lines.map((line) => line.spans.map((span) => span.text).join(''))
  if (block.list && lines.length) lines[0] = block.list.marker + ' ' + lines[0]
  if (!lines.some((line) => line.trim())) return ''
  return (
    '<w:p><w:r>' +
    lines
      .map((line) => '<w:t xml:space="preserve">' + escapeXmlText(line) + '</w:t>')
      .join('<w:br/>') +
    '</w:r></w:p>'
  )
}

// Percentage widths let a recovered table fit a narrow source cell or a text box.
function editableTable(block: TableBlock): string {
  const total = block.colWidthsPt.reduce((sum, width) => sum + width, 0)
  if (!total || !block.rows.length) return ''
  const grid = block.colWidthsPt
    .map((w) => '<w:gridCol w:w="' + Math.round(w * 20) + '"/>')
    .join('')
  const sides = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
  const borders = sides
    .map((side) => '<w:' + side + ' w:val="single" w:sz="4" w:color="auto"/>')
    .join('')
  const rows = block.rows.map((row) => {
    let column = 0
    const cells = row.map((cell) => {
      const width = block.colWidthsPt
        .slice(column, column + cell.gridSpan)
        .reduce((sum, w) => sum + w, 0)
      column += cell.gridSpan
      const span = cell.gridSpan > 1 ? '<w:gridSpan w:val="' + cell.gridSpan + '"/>' : ''
      const merge = cell.vMerge ? '<w:vMerge w:val="' + cell.vMerge + '"/>' : ''
      return (
        '<w:tc><w:tcPr><w:tcW w:type="pct" w:w="' +
        Math.round((width / total) * 5000) +
        '"/>' +
        span +
        merge +
        '</w:tcPr>' +
        (cell.blocks.map(textParagraph).join('') || '<w:p/>') +
        '</w:tc>'
      )
    })
    return '<w:tr>' + cells.join('') + '</w:tr>'
  })
  return (
    '<w:tbl><w:tblPr><w:tblW w:type="pct" w:w="5000"/><w:tblBorders>' +
    borders +
    '</w:tblBorders></w:tblPr><w:tblGrid>' +
    grid +
    '</w:tblGrid>' +
    rows.join('') +
    '</w:tbl>'
  )
}

export async function recognizedPicturePages(
  bytes: Uint8Array,
  pdfium: PdfiumModule,
  ocr: OcrEngine,
  cellData = false,
): Promise<IrPage[]> {
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    const bmp = decodeBmpForJpeg(bytes)
    if (!bmp) return []
    for (let i = 0; i < bmp.bgra.length; i += 4) {
      const blue = bmp.bgra[i]!
      bmp.bgra[i] = bmp.bgra[i + 2]!
      bmp.bgra[i + 2] = blue
    }
    bytes = encodeRgbaPng(bmp.bgra, bmp.width, bmp.height)
  }
  const info = readImageInfo(bytes)
  if (!info) return []
  if (info.width * info.height > MAX_BMP_PIXELS) throw new Error('OCR image exceeds pixel limit')
  const pdf = await imagesToPdfBytes([bytes], { paper: null, marginPt: 0 })
  return extractIrDocument(pdf, { pdfium, ocr, cellData }).irPages
}

interface PictureContent {
  blocks: (string | ImageBlock)[]
  width: number
}

async function recognizePicture(
  bytes: Uint8Array,
  pdfium: PdfiumModule,
  ocr: OcrEngine,
  keepArt: boolean,
  plainText: boolean,
): Promise<PictureContent> {
  const pages = await recognizedPicturePages(bytes, pdfium, ocr)
  const blocks: PictureContent['blocks'] = []
  for (const page of pages)
    for (const block of page.blocks) {
      if (block.kind === 'text') blocks.push(textParagraph(block))
      else if (block.kind === 'table') {
        if (plainText)
          for (const row of block.rows)
            for (const cell of row) blocks.push(...cell.blocks.map(textParagraph))
        else blocks.push(editableTable(block))
      } else if (keepArt && block.kind === 'image') blocks.push(block)
    }
  return {
    blocks: blocks.some((b) => typeof b === 'string' && b.length > 0) ? blocks : [],
    width: pages[0]?.widthPt ?? 0,
  }
}

/** End offsets in the same paragraph coordinates as wordPictureReferences, including text boxes. */
function* paragraphEnds(xml: string) {
  const stack: number[] = []
  let ordinal = 0
  for (const tag of xml.matchAll(
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)w:p(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>/g,
  )) {
    if (tag[1] === undefined) continue
    if (tag[1]) {
      const paragraph = stack.pop()
      if (paragraph) yield { paragraph, end: tag.index + tag[0].length }
    } else if (!tag[0].endsWith('/>')) stack.push(++ordinal)
    else ordinal++
  }
}

function relationships(part: string): string {
  return posix.join(posix.dirname(part), '_rels', posix.basename(part) + '.rels')
}

/** Keep the authored package, adding OCR next to scans or replacing their renderings in the editor copy. */
export async function ocrOfficeWord(
  input: string,
  output: string,
  pdfium: PdfiumModule,
  ocr: OcrEngine,
  replacePictures = false,
  plainText = false,
): Promise<void> {
  const original = await readFile(input)
  const zip = await loadDocxZip(original)
  const main = await resolveMainDocumentPath(zip)
  if (!main) throw new Error('Word document part is missing')
  const mainRels = await parseRels(zip, relationships(main))
  const parts = new Set([main])
  for (const rel of mainRels.values()) {
    if (rel.targetMode === 'External' || !/\/(header|footer|footnotes|endnotes)$/.test(rel.type))
      continue
    const target = resolveRelationshipTargetPath(main, rel.target)
    if (target) parts.add(target)
  }
  const recognized = new Map<string, PictureContent>()
  async function recognize(path: string): Promise<PictureContent> {
    if (!recognized.has(path)) {
      const bytes = await zip.file(path)!.async('uint8array')
      recognized.set(path, await recognizePicture(bytes, pdfium, ocr, replacePictures, plainText))
    }
    return recognized.get(path)!
  }
  let changed = false,
    hasText = false,
    hasPictures = false
  for (const part of parts) {
    const xml = await zip.file(part)?.async('string')
    if (!xml) continue
    hasText ||= /<w:t(?=[\s>])[^>]*>\s*[^\s<]/.test(xml)
    const rels = part === main ? mainRels : await parseRels(zip, relationships(part))
    const pictures = new Map<number, Set<string>>()
    const targets = new Map<number, string>()
    for (const ref of wordPictureReferences(xml)) {
      const rel = rels.get(ref.relId)
      if (!rel || rel.targetMode === 'External' || !rel.type.endsWith('/image')) continue
      const target = resolveRelationshipTargetPath(part, rel.target)
      if (!target || !zip.file(target)) continue
      if (
        /^rOcrArt[0-9a-f]{64}x*$/.test(ref.relId) &&
        /\/tandem-ocr-art-[0-9a-f]{64}\.(png|jpg)$/.test(target)
      )
        continue
      hasPictures = true
      if (replacePictures) targets.set(ref.offset, target)
      const paths = pictures.get(ref.paragraph) ?? new Set<string>()
      paths.add(target)
      pictures.set(ref.paragraph, paths)
    }
    if (!pictures.size) continue
    const previous = new Set<number>()
    const chunks: string[] = []
    let cursor = 0
    // A directly converted document usually has no adjacent OCR annotation from an earlier batch.
    const paragraphs =
      replacePictures && !xml.includes('tandem-picture-ocr-') ? [] : paragraphEnds(xml)
    for (const { paragraph, end } of paragraphs) {
      const paths = pictures.get(paragraph)
      if (!paths) continue
      const key = createHash('sha256')
        .update(JSON.stringify([...paths]))
        .digest('hex')
        .slice(0, 24)
      const marker = 'tandem-picture-ocr-' + key
      // An adjacent tagged block can be edited in Word without duplicating the result on a second pass.
      if (
        /^\s*<w:sdt\b[^>]*>\s*<w:sdtPr\b[^>]*>[\s\S]*?<\/w:sdtPr>/
          .exec(xml.slice(end, end + 2048))?.[0]
          .includes('w:val="' + marker + '"')
      ) {
        if (replacePictures) previous.add(end)
        continue
      }
      if (replacePictures) continue
      const additions: string[] = []
      for (const path of paths) {
        additions.push((await recognize(path)).blocks.join(''))
      }
      const blocks = additions.join('')
      if (!blocks) continue
      chunks.push(
        xml.slice(cursor, end),
        '<w:sdt><w:sdtPr><w:tag w:val="' + marker + '"/></w:sdtPr><w:sdtContent>',
        blocks,
        blocks.endsWith('</w:tbl>') ? '<w:p/>' : '',
        '</w:sdtContent></w:sdt>',
      )
      cursor = end
    }
    const art = replacePictures ? recoveredWordArt(zip, part, xml, rels.keys()) : undefined
    const result = art
      ? await replaceWordPictures(
          xml,
          targets,
          async (path, drawing, previous) => {
            const content = await recognize(path)
            if (!content.blocks.length) return null
            const extent = /<wp:extent\b[^>]*\bcx="(\d+)"/.exec(drawing)
            const scale = extent && content.width ? Number(extent[1]) / 9525 / content.width : 4 / 3
            return content.blocks
              .map((block) =>
                typeof block === 'string' ? (previous ? '' : block) : art.paragraph(block, scale),
              )
              .join('')
          },
          (end) => previous.has(end),
        )
      : chunks.length
        ? chunks.join('') + xml.slice(cursor)
        : xml
    if (result !== xml) {
      zip.file(part, result)
      await art?.finish(relationships(part))
      changed = true
    }
  }
  if (!changed && hasPictures && !hasText) throw new Error('OCR_NO_TEXT')
  await writeFile(
    output,
    changed ? await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) : original,
  )
}
