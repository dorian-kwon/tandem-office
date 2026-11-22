/** Character ranges let us retain the original XML of the surrounding table, runs and styles. */
interface ElementRange {
  name: string
  start: number
  inner: number
  end: number
  parent?: ElementRange
  properties?: ElementRange
}

interface Scan {
  target: string
  drawing: ElementRange
  run: ElementRange
  paragraph: ElementRange
}

function picturePlacements(xml: string, targets: ReadonlyMap<number, string>): Scan[] {
  const stack: ElementRange[] = []
  const scans: Scan[] = []
  const tags =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([\w:.-]+)(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>/g
  const active: { drawing: ElementRange; target?: string; unsafe: boolean }[] = []
  for (const tag of xml.matchAll(tags)) {
    const name = tag[2]
    if (!name) continue
    if (tag[1]) {
      const node = stack.pop()
      if (!node) continue
      node.end = tag.index + tag[0].length
      const current = active.at(-1)
      if (current?.drawing === node) {
        const { target, unsafe, drawing } = current
        const run = node.parent
        const paragraph = run?.parent
        if (target && !unsafe && run && paragraph) scans.push({ target, drawing, run, paragraph })
        active.pop()
      }
      continue
    }
    const parent = stack.at(-1)
    const end = tag.index + tag[0].length
    const node: ElementRange = { name, start: tag.index, inner: end, end, parent }
    if (
      parent &&
      ((name === 'w:rPr' && parent.name === 'w:r') || (name === 'w:pPr' && parent.name === 'w:p'))
    )
      parent.properties = node
    if (
      parent?.name === 'w:r' &&
      parent.parent?.name === 'w:p' &&
      (name === 'w:drawing' || name === 'w:pict' || name === 'mc:AlternateContent')
    ) {
      if (!tag[0].endsWith('/>')) active.push({ drawing: node, unsafe: false })
    }
    const current = active.at(-1)
    if (current) {
      // A shape group, text box or compound object may also carry authored content.
      if (
        /(?:^|:)(?:grpSp|wgp|group|txbxContent|textbox|object|chart|oleObj|graphicFrame)$/.test(
          name,
        )
      )
        current.unsafe = true
      if (
        /(?:^|:)(?:blip|imagedata|fill)$/.test(name) &&
        /\sr:(?:id|embed|link)\s*=/.test(tag[0])
      ) {
        const path = targets.get(tag.index)
        if (!path || (current.target && current.target !== path)) current.unsafe = true
        if (path) current.target = path
      }
    }
    if (!tag[0].endsWith('/>')) stack.push(node)
  }
  return scans
}

function inlineText(blocks: string): string | undefined {
  if (!blocks || blocks.includes('<w:tbl>')) return undefined
  return blocks
    .slice('<w:p><w:r>'.length, -'</w:r></w:p>'.length)
    .replaceAll('</w:r></w:p><w:p><w:r>', '<w:br/>')
}

function opening(xml: string, node: ElementRange): string {
  const pr = node.properties
  return xml.slice(node.start, node.inner) + (pr ? xml.slice(pr.start, pr.end) : '')
}

function pictureOnly(xml: string, scan: Scan): boolean {
  const { drawing, run, paragraph } = scan
  return (
    xml.slice(paragraph.start, drawing.start).trim() ===
      opening(xml, paragraph) + opening(xml, run) &&
    xml.slice(drawing.end, paragraph.end).trim() === '</w:r></w:p>'
  )
}

export async function replaceWordPictures(
  xml: string,
  targets: ReadonlyMap<number, string>,
  recognize: (target: string, drawing: string, previous: boolean) => Promise<string | null>,
  hasPreviousResult: (paragraphEnd: number) => boolean,
): Promise<string> {
  const edits: { start: number; end: number; replacement: string }[] = []
  for (const scan of picturePlacements(xml, targets)) {
    const { drawing, paragraph, run } = scan
    const previous = hasPreviousResult(paragraph.end)
    const blocks = await recognize(scan.target, xml.slice(drawing.start, drawing.end), previous)
    if (blocks === null) continue
    if (previous) {
      // An adjacent OCR block may have been edited since the batch result was saved.
      edits.push({ start: drawing.start, end: drawing.end, replacement: inlineText(blocks) ?? '' })
      continue
    }
    const text = inlineText(blocks)
    if (text !== undefined) {
      edits.push({ start: drawing.start, end: drawing.end, replacement: text })
      continue
    }
    if (pictureOnly(xml, scan)) {
      edits.push({
        start: paragraph.start,
        end: paragraph.end,
        replacement:
          blocks +
          (paragraph.properties
            ? opening(xml, paragraph) + '</w:p>'
            : blocks.endsWith('</w:tbl>')
              ? '<w:p/>'
              : ''),
      })
      continue
    }
    // Tables are block-level children. Retain text on either side of an inline image.
    // Avoid duplicating paragraph identifiers, list numbers and section breaks in a split.
    const rPr = run.properties
    const runStyle = rPr ? xml.slice(rPr.start, rPr.end) : ''
    const pPr = paragraph.properties
    const pStyle = pPr ? xml.slice(pPr.start, pPr.end) : ''
    const splitStyle = pStyle.includes('<w:sectPr') || pStyle.includes('<w:numPr') ? '' : pStyle
    if (pStyle.includes('<w:sectPr')) continue
    edits.push({
      start: drawing.start,
      end: drawing.end,
      replacement: '</w:r></w:p>' + blocks + '<w:p>' + splitStyle + '<w:r>' + runStyle,
    })
  }
  if (!edits.length) return xml
  let cursor = 0
  const parts: string[] = []
  for (const { start, end, replacement } of edits) {
    parts.push(xml.slice(cursor, start), replacement)
    cursor = end
  }
  return parts.join('') + xml.slice(cursor)
}
