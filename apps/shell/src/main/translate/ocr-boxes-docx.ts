import { buildAnchoredTextboxParagraphXml } from '@genoffice/docx-engine'
import { boxFontHalfPoints, type OcrBox } from '../../shared/ocr-boxes'

/**
 * Boxes over a docx picture (docs/plans/ocr-box-placement.md). A box is an anchored text box
 * (the editor and the translation already read those), written as holder paragraphs right after
 * the picture paragraph and moved up onto the picture. That only lines up when the picture
 * sits alone on a left-aligned line of the body, so every other picture keeps the list
 * placements. The box fill is opaque white so the translation stays readable over the original
 * pixels; the picture itself is never touched.
 */

export type BoxableInfo =
  | { ok: true; widthEmu: number; heightEmu: number; afterTwips: number }
  | {
      ok: false
      reason: 'missing' | 'anchored' | 'cropped' | 'rotated' | 'container' | 'crowded' | 'aligned'
    }

/** exact line height (twips) of each holder paragraph, so the holders add almost no height */
const HOLDER_LINE_TWIPS = 20
const EMU_PER_TWIP = 635
const EMU_PER_POINT = 12700

/**
 * Where the paragraph numbered `n` (1-based, `<w:p>` start tags in document order, nested ones
 * included: the numbering of the picture list and of the placement) starts and ends.
 */
function paragraphSpan(xml: string, n: number): { start: number; end: number } | null {
  let count = 0
  const stack: { number: number; start: number }[] = []
  for (const tag of xml.matchAll(/<\/?w:p\b[^>]*>/g)) {
    if (tag[0].startsWith('</')) {
      const open = stack.pop()
      if (open?.number === n) return { start: open.start, end: tag.index! + tag[0].length }
    } else {
      const number = ++count
      if (tag[0].endsWith('/>')) {
        if (number === n) return null
      } else stack.push({ number, start: tag.index! })
    }
  }
  return null
}

/** how many table cells and text boxes are open where `offset` lies */
function insideContainer(xml: string, offset: number): boolean {
  let cells = 0
  let boxes = 0
  for (const tag of xml.slice(0, offset).matchAll(/<(\/?)w:(tc|txbxContent)\b[^>]*?(\/?)>/g)) {
    if (tag[3] === '/') continue
    const delta = tag[1] === '/' ? -1 : 1
    if (tag[2] === 'tc') cells += delta
    else boxes += delta
  }
  return cells > 0 || boxes > 0
}

const attr = (tag: string, name: string): string | undefined =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1]

/** whether the picture `relId` in paragraph `paragraph` of `part` can take boxes, and its placed size */
export function inspectBoxableImage(
  part: string,
  xml: string,
  paragraph: number,
  relId: string,
): BoxableInfo {
  if (part !== 'word/document.xml') return { ok: false, reason: 'container' }
  const span = paragraphSpan(xml, paragraph)
  if (!span) return { ok: false, reason: 'missing' }
  if (insideContainer(xml, span.start)) return { ok: false, reason: 'container' }
  const p = xml.slice(span.start, span.end)
  const drawings = p.match(/<w:drawing\b/g)?.length ?? 0
  if (
    drawings !== 1 ||
    /<w:pict\b|<w:object\b|<mc:AlternateContent\b/.test(p) ||
    [...p.matchAll(/<w:t\b[^>]*>([^<]*)<\/w:t>/g)].some((m) => m[1]!.trim() !== '')
  )
    return { ok: false, reason: drawings === 0 ? 'missing' : 'crowded' }
  if (!new RegExp(`r:embed="${relId.replace(/[^\w-]/g, '')}"`).test(p))
    return { ok: false, reason: 'missing' }
  if (!/<wp:inline\b/.test(p)) return { ok: false, reason: 'anchored' }
  const crop = /<a:srcRect\b([^>]*)>/.exec(p)?.[1]
  if (crop && /\b[ltrb]="(?!0")[^"]+"/.test(crop)) return { ok: false, reason: 'cropped' }
  for (const xfrm of p.matchAll(/<a:xfrm\b[^>]*>/g)) {
    const rot = attr(xfrm[0], 'rot')
    const flip = ['flipH', 'flipV'].some((name) =>
      ['1', 'true'].includes(attr(xfrm[0], name) ?? ''),
    )
    if ((rot !== undefined && rot !== '0') || flip) return { ok: false, reason: 'rotated' }
  }
  const pPr = /<w:pPr>[\s\S]*?<\/w:pPr>/.exec(p)?.[0] ?? ''
  const jc = /<w:jc\b[^>]*>/.exec(pPr)?.[0]
  const indent = /<w:ind\b[^>]*>/.exec(pPr)?.[0]
  const spacing = /<w:spacing\b[^>]*>/.exec(pPr)?.[0] ?? ''
  if (
    (jc && !['left', 'start'].includes(attr(jc, 'w:val') ?? '')) ||
    (indent && /\bw:\w+="(?!0")[^"]+"/.test(indent)) ||
    attr(spacing, 'w:lineRule') === 'exact'
  )
    return { ok: false, reason: 'aligned' }
  const extent = /<wp:extent\b[^>]*>/.exec(p)?.[0] ?? ''
  const widthEmu = Number(attr(extent, 'cx'))
  const heightEmu = Number(attr(extent, 'cy'))
  if (!(widthEmu > 0) || !(heightEmu > 0)) return { ok: false, reason: 'missing' }
  const afterTwips = Number(attr(spacing, 'w:after') ?? 0)
  return { ok: true, widthEmu, heightEmu, afterTwips: afterTwips > 0 ? afterTwips : 0 }
}

/** the next free `wp:docPr` id of a document part */
export function nextDocPrId(xml: string): number {
  let max = 0
  for (const m of xml.matchAll(/<wp:docPr\b[^>]*\bid="(\d+)"/g)) max = Math.max(max, Number(m[1]))
  return max + 1
}

const clean = (value: string): string =>
  Array.from(value)
    .filter((char) => char.charCodeAt(0) >= 32 || char === '\n' || char === '\r' || char === '\t')
    .join('')

/**
 * The holder paragraphs of one picture's boxes. Box k sits k holder lines further down than box
 * 0, which sits right after the picture paragraph and its spacing, so every box is moved up by
 * the picture height, the spacing and its own holder offset to land at its place on the picture.
 */
export function buildImageBoxParagraphsXml(
  boxes: readonly OcrBox[],
  info: Extract<BoxableInfo, { ok: true }>,
  firstDocPrId: number,
): string {
  const { widthEmu, heightEmu, afterTwips } = info
  return boxes
    .map((box, k) => {
      const half = boxFontHalfPoints(box, heightEmu / EMU_PER_POINT)
      return buildAnchoredTextboxParagraphXml({
        anchor: 'paragraph',
        xEmu: Math.round(box.x * widthEmu),
        yEmu: Math.round(
          box.y * heightEmu -
            (heightEmu + afterTwips * EMU_PER_TWIP) -
            k * HOLDER_LINE_TWIPS * EMU_PER_TWIP,
        ),
        widthEmu: Math.max(1, Math.round(box.w * widthEmu)),
        heightEmu: Math.max(1, Math.round(box.h * heightEmu)),
        paragraphs: clean(box.text)
          .split(/\r?\n/)
          .map((line) => ({ runs: [{ text: line, sizeHalfPoints: half }] })),
        id: firstDocPrId + k,
        fillHex: 'FFFFFF',
        insetsEmu: { l: 0, t: 0, r: 0, b: 0 },
        wrap: 'none',
        holderLineTwips: HOLDER_LINE_TWIPS,
      })
    })
    .join('')
}
