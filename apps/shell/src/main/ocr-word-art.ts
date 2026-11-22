import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type JSZip from 'jszip'
import { inlinePictureDrawingXml } from '../../../../packages/docx-engine/src/generate'
import type { ImageBlock } from '../../../../packages/pdf2docx/src'
import { nextDocPrId } from './translate/ocr-boxes-docx'

const relNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const drawingNs = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'

/** The recognizer cuts out artwork around the text. Keep that artwork in the same part. */
export function recoveredWordArt(zip: JSZip, part: string, xml: string, relIds: Iterable<string>) {
  let docPrId = nextDocPrId(xml)
  const existing = new Set(relIds)
  const relations = new Map<string, string>()
  const extensions = new Map<string, string>()
  function paragraph(image: ImageBlock, scale: number): string {
    const hash = createHash('sha256').update(image.data).digest('hex')
    const ext = image.mime === 'image/png' ? 'png' : 'jpg'
    const target = 'media/tandem-ocr-art-' + hash + '.' + ext
    let rId = relations.get(target)
    if (!rId) {
      rId = 'rOcrArt' + hash
      while (existing.has(rId)) rId += 'x'
      existing.add(rId)
      relations.set(target, rId)
      extensions.set(ext, image.mime)
      zip.file(posix.join(posix.dirname(part), target), image.data)
    }
    const { x0, x1, y0, y1 } = image.box
    const drawing = inlinePictureDrawingXml({
      rId,
      docPrId: docPrId++,
      widthPx: (x1 - x0) * scale,
      heightPx: (y1 - y0) * scale,
    }).replace('<w:drawing>', '<w:drawing xmlns:wp="' + drawingNs + '" xmlns:r="' + relNs + '">')
    return '<w:p><w:r>' + drawing + '</w:r></w:p>'
  }
  async function finish(relsPath: string): Promise<void> {
    if (!relations.size) return
    const rels = await zip.file(relsPath)!.async('string')
    const additions = [...relations]
      .map(
        ([target, id]) =>
          '<Relationship Id="' + id + '" Type="' + relNs + '/image" Target="' + target + '"/>',
      )
      .join('')
    zip.file(
      relsPath,
      rels.replace(/<\/((?:[\w.-]+:)?Relationships)>/, (_, name: string) => {
        const prefix = name.slice(0, name.lastIndexOf(':') + 1)
        return (
          additions.replaceAll('<Relationship ', '<' + prefix + 'Relationship ') + '</' + name + '>'
        )
      }),
    )
    const types = await zip.file('[Content_Types].xml')?.async('string')
    if (!types) return
    const missing = [...extensions].filter(
      ([ext]) =>
        !new RegExp('<(?:[\\w.-]+:)?Default\\b[^>]*\\bExtension=["\']' + ext + '["\']', 'i').test(
          types,
        ),
    )
    if (missing.length)
      zip.file(
        '[Content_Types].xml',
        types.replace(/<\/((?:[\w.-]+:)?Types)>/, (_, name: string) => {
          const prefix = name.slice(0, name.lastIndexOf(':') + 1)
          return (
            missing
              .map(
                ([ext, mime]) =>
                  '<' + prefix + 'Default Extension="' + ext + '" ContentType="' + mime + '"/>',
              )
              .join('') +
            '</' +
            name +
            '>'
          )
        }),
      )
  }
  return { paragraph, finish }
}
