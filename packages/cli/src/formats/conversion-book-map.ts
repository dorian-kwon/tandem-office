import { randomUUID } from 'node:crypto'
import JSZip from 'jszip'
import { openEpub, resolveHref } from '@genoffice/epub-engine/core'
import {
  createXmindDocumentFromOutline,
  createXmindDocumentFromSheets,
  newSheet,
  newTopic,
  openXmind,
  sheetsToOutline,
} from '@genoffice/xmind-engine'
import { escapeText, xhtmlDocument, xmlClean } from '../../../pdf-structure/src/epub/xml'
import { ensureDom } from '../dom'
import { bodyBlocks } from './conversion-html'
import type { CommandContext } from '../registry'
import { CliError, EXIT } from '../result'

const raster = /^image\/(?:png|jpeg|gif|bmp)$/i
const dataImage = /^data:(image\/(?:png|jpeg|gif));base64,([a-z0-9+/=\s]+)$/i

/** A reflowable EPUB, with editable XHTML and packaged figures in the same body order. */
export async function bodyHtmlToEpub(html: string, title: string, ctx: CommandContext) {
  await ensureDom()
  const body = new DOMParser().parseFromString(html, 'text/html').body
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  zip.file(
    'META-INF/container.xml',
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  )
  const images = new Map<string, string>()
  const items: string[] = []
  let omitted = 0
  for (const image of body.querySelectorAll('img')) {
    const src = image.getAttribute('src') ?? ''
    const match = dataImage.exec(src)
    if (!match) {
      image.replaceWith(image.alt)
      omitted++
      continue
    }
    let path = images.get(src)
    if (!path) {
      const mime = match[1]!.toLowerCase()
      const id = 'image-' + (images.size + 1)
      path = 'images/' + id + '.' + mime.slice(6)
      images.set(src, path)
      zip.file('EPUB/' + path, Buffer.from(match[2]!, 'base64'))
      items.push(`<item id="${id}" href="${path}" media-type="${mime}"/>`)
    }
    image.setAttribute('src', path)
    if (!image.hasAttribute('alt')) image.setAttribute('alt', '')
  }
  if (omitted)
    ctx.warn({ code: 'images_dropped', message: `${omitted} unsupported EPUB image(s) omitted` })
  const serializer = new XMLSerializer()
  const markup = Array.from(body.childNodes, (node) => serializer.serializeToString(node)).join('')
  zip.file('EPUB/body.xhtml', xhtmlDocument(title, 'und', xmlClean(markup)))
  zip.file(
    'EPUB/nav.xhtml',
    xhtmlDocument(
      title,
      'und',
      `<nav epub:type="toc"><ol><li><a href="body.xhtml">${escapeText(title)}</a></li></ol></nav>`,
    ),
  )
  zip.file(
    'EPUB/style.css',
    'img { max-width: 100%; height: auto } table { border-collapse: collapse }',
  )
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  zip.file(
    'EPUB/book.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">urn:uuid:${randomUUID()}</dc:identifier><dc:title>${escapeText(title)}</dc:title><dc:language>und</dc:language><meta property="dcterms:modified">${modified}</meta></metadata>
<manifest><item id="body" href="body.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/><item id="css" href="style.css" media-type="text/css"/>${items.join('')}</manifest><spine><itemref idref="body"/></spine></package>`,
  )
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

export async function epubBodyHtml(bytes: Uint8Array, ctx: CommandContext) {
  await ensureDom()
  const result = await openEpub(bytes)
  if (!result.ok) throw new CliError(EXIT.conversion, `EPUB (${result.reason}): ${result.detail}`)
  const book = result.book
  const types = new Map(book.manifest.map((item) => [item.path, item.mediaType]))
  const parts: string[] = []
  let skipped = 0
  for (const item of book.spine.items) {
    if (raster.test(item.mediaType)) {
      const image = await book.read(item.path)
      if (image)
        parts.push(
          `<p><img alt="" src="data:${item.mediaType};base64,${Buffer.from(image).toString('base64')}"></p>`,
        )
      continue
    }
    if (!['application/xhtml+xml', 'text/html'].includes(item.mediaType)) {
      skipped++
      continue
    }
    const entry = await book.readText(item.path)
    if (!entry?.valid) throw new CliError(EXIT.conversion, `Unreadable EPUB chapter: ${item.path}`)
    const body = new DOMParser().parseFromString(entry.text, 'text/html').body
    for (const img of body.querySelectorAll('img')) {
      const src = img.getAttribute('src') ?? ''
      if (/^data:image\/(?:png|gif|bmp|jpeg);base64,/i.test(src)) continue
      const target = resolveHref(item.path, src)
      const mime = target && types.get(target.path)
      const image = mime && raster.test(mime) && target ? await book.read(target.path) : null
      // Never let a relative archive URL fall through to a path on the user's disk.
      img.setAttribute(
        'src',
        image ? `data:${mime};base64,${Buffer.from(image).toString('base64')}` : 'about:blank',
      )
    }
    parts.push(body.innerHTML)
  }
  if (!parts.length)
    throw new CliError(EXIT.conversion, 'This EPUB has no supported reading-order content.')
  if (skipped)
    ctx.warn({
      code: 'epub_spine_skipped',
      message: `${skipped} unsupported reading-order item(s) omitted`,
    })
  return parts.join('\n')
}

/** The engine's full outline includes every sheet, note and child, without AI folding. */
export async function xmindOutlineHtml(bytes: Uint8Array) {
  const opened = await openXmind(bytes)
  if (opened.status !== 'ok')
    throw new CliError(EXIT.conversion, `XMind (${opened.status}): ${opened.detail}`)
  return sheetsToOutline(opened.document.sheets)
    .trimEnd()
    .split('\n')
    .map((line) => {
      const indent = line.length - line.trimStart().length
      return '<p>' + '&#160;'.repeat(indent) + escapeText(line.slice(indent)) + '</p>'
    })
    .join('')
}

export async function bodyHtmlToXmind(html: string, title: string) {
  await ensureDom()
  const body = new DOMParser().parseFromString(html, 'text/html').body
  const lines: string[] = []
  for (const node of bodyBlocks(body)) {
    if (node.tagName === 'TABLE') {
      for (const row of (node as HTMLTableElement).rows) {
        const cells = Array.from(row.cells, (cell) => cell.textContent.trim())
        if (cells.some(Boolean)) lines.push(cells.join(' | '))
      }
    } else {
      lines.push(node.textContent.replace(/\u00a0/g, ' '))
    }
  }
  const nonempty = lines.filter((line) => line.trim())
  if (
    /^#(?: |$)/.test(nonempty[0] ?? '') &&
    nonempty.every((line) => /^\s*(?:#|-|>)(?: |$)/.test(line))
  ) {
    return (await createXmindDocumentFromOutline(lines.join('\n'), { untitled: title })).save()
  }
  const sheet = newSheet({ title, rootTitle: title })
  sheet.rootTopic.children = { attached: nonempty.map((line) => newTopic(line.trim())) }
  return (await createXmindDocumentFromSheets([sheet])).save()
}
