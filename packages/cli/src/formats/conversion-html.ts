import { ensureDom } from '../dom'
import type { CommandContext } from '../registry'
import { loadLocalImage } from './markdown'
import { escapeText } from '../../../pdf-structure/src/epub/xml'

export function textBodyHtml(text: string): string {
  return text
    .split(/\r\n|\n|\r/)
    .map((line) => '<p>' + escapeText(line) + '</p>')
    .join('')
}

/** Make onward conversion self-contained before an intermediate moves away from source assets. */
export async function conversionHtml(
  html: string,
  input: string,
  ctx: CommandContext,
): Promise<string> {
  await ensureDom()
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc
    .querySelectorAll(
      'script,style,link,base,meta,iframe,frame,frameset,object,embed,template,form,video,audio,source,svg,math',
    )
    .forEach((el) => el.remove())
  for (const node of doc.body.querySelectorAll('*')) {
    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase()
      // Only carry attributes needed by an editable paragraph, table, link or picture.
      if (
        [
          'alt',
          'colspan',
          'rowspan',
          'scope',
          'height',
          'width',
          'lang',
          'dir',
          'title',
          'class',
          'id',
          'align',
          'start',
          'type',
          'value',
        ].includes(name)
      )
        continue
      if (name === 'src' && node.tagName === 'IMG') continue
      if (name === 'href' && node.tagName === 'A' && /^(?:https?:\/\/|mailto:|#)/i.test(attr.value))
        continue
      if (name === 'style' && !/url\s*\(|@import|expression\s*\(|\\|\/\*/i.test(attr.value))
        continue
      node.removeAttribute(attr.name)
    }
  }
  let missing = 0
  for (const image of doc.body.querySelectorAll('img')) {
    const src = image.getAttribute('src') ?? ''
    if (/^data:image\/(?:png|jpe?g|gif|bmp);base64,/i.test(src)) continue
    const resource =
      src && !/^(?:[a-z][\w+.-]*:|[/\\]{2})/i.test(src)
        ? await loadLocalImage(src, { file: input, ctx })
        : null
    if (resource) image.src = 'data:' + resource.mime + ';base64,' + resource.base64
    else {
      image.replaceWith(image.alt)
      missing++
    }
  }
  if (missing)
    ctx.warn({
      code: 'images_dropped',
      message: `${missing} linked or unsupported image(s) were unavailable`,
    })
  return (
    '<!doctype html><html><head><meta charset="utf-8"></head><body>' +
    doc.body.innerHTML +
    '</body></html>'
  )
}

// Unwrap chapter/section containers in a copy so tables and paragraphs keep their order.
export function bodyBlocks(body: HTMLElement): Element[] {
  for (const wrapper of body.querySelectorAll(
    'section,article,main,header,footer,blockquote,ul,ol,div',
  )) {
    if (
      !wrapper.closest('table') &&
      wrapper.children.length &&
      wrapper.querySelector('p,table,li,div,section,h1,h2,h3,h4,h5,h6')
    ) {
      wrapper.replaceWith(...Array.from(wrapper.childNodes))
    }
  }
  for (const node of [...body.childNodes]) {
    if (node.nodeType === 3 && node.textContent?.trim()) {
      const paragraph = body.ownerDocument.createElement('p')
      paragraph.textContent = node.textContent
      node.replaceWith(paragraph)
    }
  }
  return [...body.children]
}

/** Plain text keeps paragraph and table boundaries, but excludes the head and active content. */
export async function bodyHtmlText(html: string): Promise<string> {
  await ensureDom()
  const body = new DOMParser().parseFromString(html, 'text/html').body
  body.querySelectorAll('script,style,template').forEach((el) => el.remove())
  for (const img of body.querySelectorAll('img')) img.replaceWith(img.alt)
  for (const el of body.querySelectorAll('br')) el.replaceWith('\n')
  for (const row of body.querySelectorAll('tr'))
    for (const cell of Array.from(row.cells).slice(1)) cell.before('\t')
  for (const el of body.querySelectorAll(
    'p,div,li,section,article,blockquote,h1,h2,h3,h4,h5,h6,pre,tr,table',
  )) {
    if (!el.closest('td,th')) el.append('\n')
  }
  return body.textContent.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}
