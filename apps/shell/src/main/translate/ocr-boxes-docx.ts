import { buildAnchoredTextboxParagraphXml } from '@genoffice/docx-engine'
import { fitBoxFontHalfPoints, type OcrBox } from '../../shared/ocr-boxes'

/**
 * Boxes over a docx picture (docs/plans/ocr-box-placement.md). A box is an anchored text box
 * (the editor and the translation read those, also the ones inside table cells), written as one
 * holder paragraph right after the picture paragraph and moved up onto the picture. That only
 * lines up when the picture sits alone on a left-aligned line of the body or of a table cell, so
 * every other picture (in a text box, a header, behind the text, a background) keeps the list
 * placements. The box fill is opaque white so the translation stays readable over the original
 * pixels; the picture itself is never touched.
 */

export type BoxableInfo =
  | { ok: true; widthEmu: number; heightEmu: number; afterTwips: number }
  | {
      ok: false
      reason:
        | 'missing'
        | 'anchored'
        | 'cropped'
        | 'rotated'
        | 'container'
        | 'crowded'
        | 'aligned'
        | 'section'
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

/** whether `offset` lies inside the content of a text box, which takes no boxes of its own */
function insideTextBox(xml: string, offset: number): boolean {
  let open = 0
  for (const tag of xml.slice(0, offset).matchAll(/<(\/?)w:txbxContent\b[^>]*?(\/?)>/g)) {
    if (tag[2] === '/') continue
    open += tag[1] === '/' ? -1 : 1
  }
  return open > 0
}

/**
 * The style id of the innermost table that holds `offset`: an empty string when that table names
 * none, null when `offset` is not inside a table.
 */
function tableStyleAt(xml: string, offset: number): string | null {
  const starts: number[] = []
  for (const tag of xml.slice(0, offset).matchAll(/<(\/?)w:tbl>/g)) {
    if (tag[1] === '/') starts.pop()
    else starts.push(tag.index!)
  }
  const start = starts.at(-1)
  if (start === undefined) return null
  const tblPr = /<w:tblPr>[\s\S]*?<\/w:tblPr>/.exec(xml.slice(start))?.[0] ?? ''
  return /<w:tblStyle\b[^>]*w:val="([^"]*)"/.exec(tblPr)?.[1] ?? ''
}

const attr = (tag: string, name: string): string | undefined =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1]

/** what one `<w:pPr>` says about the properties that move a picture line; absent = not stated */
interface PPrFacts {
  after?: number
  jc?: string
  /** an indent that moves the first line */
  indented?: boolean
  numbered?: boolean
  exact?: boolean
}

const INDENT_ATTRS = ['left', 'start', 'right', 'end', 'firstLine', 'hanging']

function readPPr(pPr: string): PPrFacts {
  const facts: PPrFacts = {}
  const spacing = /<w:spacing\b[^>]*>/.exec(pPr)?.[0]
  if (spacing) {
    const after = attr(spacing, 'w:after')
    if (after !== undefined && Number.isFinite(Number(after))) facts.after = Number(after)
    const rule = attr(spacing, 'w:lineRule')
    if (rule !== undefined) facts.exact = rule === 'exact'
  }
  const jc = /<w:jc\b[^>]*>/.exec(pPr)?.[0]
  const jcValue = jc && attr(jc, 'w:val')
  if (jcValue) facts.jc = jcValue
  const indent = /<w:ind\b[^>]*>/.exec(pPr)?.[0]
  if (indent)
    facts.indented = INDENT_ATTRS.some((name) =>
      [`w:${name}`, `w:${name}Chars`].some((key) => {
        const value = attr(indent, key)
        return value !== undefined && Number(value) !== 0
      }),
    )
  const numbering = /<w:numPr>[\s\S]*?<\/w:numPr>/.exec(pPr)?.[0]
  if (numbering !== undefined)
    facts.numbered = (/<w:numId\b[^>]*w:val="([^"]*)"/.exec(numbering)?.[1] ?? '0') !== '0'
  return facts
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** the pPr of each style in a `basedOn` chain, nearest first; null when a style is missing or the chain loops */
function styleChain(styles: string, startId: string | undefined): PPrFacts[] | null {
  const layers: PPrFacts[] = []
  const seen = new Set<string>()
  let id = startId
  while (id !== undefined) {
    if (seen.has(id) || seen.size > 20) return null
    seen.add(id)
    const block = new RegExp(
      `<w:style\\b[^>]*\\bw:styleId="${escapeRegExp(id)}"[^>]*>([\\s\\S]*?)</w:style>`,
    ).exec(styles)?.[1]
    if (block === undefined) return null
    layers.push(readPPr(/<w:pPr>[\s\S]*?<\/w:pPr>/.exec(block)?.[0] ?? ''))
    id = /<w:basedOn\b[^>]*w:val="([^"]*)"/.exec(block)?.[1]
  }
  return layers
}

/** the id of the default style of a type (paragraph or table), when the styles name one */
function defaultStyleId(styles: string, type: 'paragraph' | 'table'): string | undefined {
  const tag = [...styles.matchAll(/<w:style\b[^>]*>/g)]
    .map((m) => m[0])
    .find((open) => attr(open, 'w:type') === type && attr(open, 'w:default') === '1')
  return tag ? attr(tag, 'w:styleId') : undefined
}

/**
 * The paragraph properties in force: the paragraph's own, then its style and the styles it is
 * based on, then (inside a table) the table's style, then the document defaults, the first one
 * that states a property winning. Word's own table styles state a spacing after of 0 and win over
 * the document default, so a picture in a cell must not use the default. Null when a style it
 * names is missing or a chain loops, because then nothing can be said safely.
 */
function effectiveFacts(
  directPPr: string,
  styles: string | undefined,
  tableStyle: string | null,
): PPrFacts | null {
  const layers: PPrFacts[] = [readPPr(directPPr)]
  if (styles !== undefined) {
    const paragraphStyle =
      /<w:pStyle\b[^>]*w:val="([^"]*)"/.exec(directPPr)?.[1] ?? defaultStyleId(styles, 'paragraph')
    const paragraphLayers = styleChain(styles, paragraphStyle)
    if (!paragraphLayers) return null
    layers.push(...paragraphLayers)
    if (tableStyle !== null) {
      const tableLayers = styleChain(
        styles,
        tableStyle === '' ? defaultStyleId(styles, 'table') : tableStyle,
      )
      if (!tableLayers) return null
      layers.push(...tableLayers)
    }
    layers.push(readPPr(/<w:pPrDefault>([\s\S]*?)<\/w:pPrDefault>/.exec(styles)?.[1] ?? ''))
  }
  const pick = <K extends keyof PPrFacts>(key: K): PPrFacts[K] =>
    layers.find((layer) => layer[key] !== undefined)?.[key]
  return {
    ...(pick('after') !== undefined ? { after: pick('after') } : {}),
    ...(pick('jc') !== undefined ? { jc: pick('jc') } : {}),
    indented: pick('indented') === true,
    numbered: pick('numbered') === true,
    exact: pick('exact') === true,
  }
}

/** run content that puts something else on the picture's line: a break, tab, symbol, field, note or any text */
const LINE_CONTENT =
  /<w:(?:br|tab|cr|sym|ptab|fldChar|instrText|footnoteReference|endnoteReference)\b|<w:t\b[^>]*>[^<]+<\/w:t>/

/**
 * Whether the picture `relId` in paragraph `paragraph` of `part` can take boxes, and its placed
 * size. `styles` is `word/styles.xml` when there is one: the spacing, alignment and indent that
 * the styles and the document defaults give the paragraph count as much as its own.
 */
export function inspectBoxableImage(
  part: string,
  xml: string,
  paragraph: number,
  relId: string,
  styles?: string,
): BoxableInfo {
  if (part !== 'word/document.xml') return { ok: false, reason: 'container' }
  const span = paragraphSpan(xml, paragraph)
  if (!span) return { ok: false, reason: 'missing' }
  if (insideTextBox(xml, span.start)) return { ok: false, reason: 'container' }
  const p = xml.slice(span.start, span.end)
  const directPPr = /<w:pPr>[\s\S]*?<\/w:pPr>/.exec(p)?.[0] ?? ''
  const content = p.replace(directPPr, '')
  const drawings = content.match(/<w:drawing\b/g)?.length ?? 0
  if (
    drawings !== 1 ||
    /<w:pict\b|<w:object\b|<mc:AlternateContent\b/.test(content) ||
    LINE_CONTENT.test(content)
  )
    return { ok: false, reason: drawings === 0 ? 'missing' : 'crowded' }
  if (!new RegExp(`r:embed="${relId.replace(/[^\w-]/g, '')}"`).test(content))
    return { ok: false, reason: 'missing' }
  if (!/<wp:inline\b/.test(content)) return { ok: false, reason: 'anchored' }
  const crop = /<a:srcRect\b([^>]*)>/.exec(content)?.[1]
  if (crop && /\b[ltrb]="(?!0")[^"]+"/.test(crop)) return { ok: false, reason: 'cropped' }
  for (const xfrm of content.matchAll(/<a:xfrm\b[^>]*>/g)) {
    const rot = attr(xfrm[0], 'rot')
    const flip = ['flipH', 'flipV'].some((name) =>
      ['1', 'true'].includes(attr(xfrm[0], name) ?? ''),
    )
    if ((rot !== undefined && rot !== '0') || flip) return { ok: false, reason: 'rotated' }
  }
  // the holders go right after this paragraph: a section break would put them in the next section
  if (/<w:sectPr\b/.test(directPPr)) return { ok: false, reason: 'section' }
  const facts = effectiveFacts(directPPr, styles, tableStyleAt(xml, span.start))
  // a justified line holding only a picture sits at the left like a left-aligned one
  if (
    !facts ||
    facts.indented ||
    facts.numbered ||
    facts.exact ||
    (facts.jc !== undefined && !['left', 'start', 'both'].includes(facts.jc))
  )
    return { ok: false, reason: 'aligned' }
  const extent = /<wp:extent\b[^>]*>/.exec(content)?.[0] ?? ''
  const widthEmu = Number(attr(extent, 'cx'))
  const heightEmu = Number(attr(extent, 'cy'))
  if (!(widthEmu > 0) || !(heightEmu > 0)) return { ok: false, reason: 'missing' }
  const afterTwips = facts.after ?? 0
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
 * The holder paragraph of one picture's boxes: every box is its own anchored text box, all of
 * them anchored in one holder paragraph that sits right after the picture paragraph and its
 * spacing. One holder keeps the added height to a single exact line and keeps the boxes
 * together on a page, and every box is moved up by the picture height and the spacing alone.
 */
export function buildImageBoxParagraphsXml(
  boxes: readonly OcrBox[],
  info: Extract<BoxableInfo, { ok: true }>,
  firstDocPrId: number,
): string {
  const { widthEmu, heightEmu, afterTwips } = info
  const parts = boxes.map((box, k) => {
    // the size the lettering had, made smaller when the text would run past the box
    const half = fitBoxFontHalfPoints(box, widthEmu / EMU_PER_POINT, heightEmu / EMU_PER_POINT)
    const holder = buildAnchoredTextboxParagraphXml({
      anchor: 'paragraph',
      xEmu: Math.round(box.x * widthEmu),
      yEmu: Math.round(box.y * heightEmu - (heightEmu + afterTwips * EMU_PER_TWIP)),
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
    const match = /^<w:p>(<w:pPr>[\s\S]*?<\/w:pPr>)?(<w:r>[\s\S]*<\/w:r>)<\/w:p>$/.exec(holder)
    if (!match) throw new Error('unexpected text box holder paragraph')
    return { pPr: match[1] ?? '', runs: match[2]! }
  })
  if (parts.length === 0) return ''
  return `<w:p>${parts[0]!.pPr}${parts.map((part) => part.runs).join('')}</w:p>`
}
