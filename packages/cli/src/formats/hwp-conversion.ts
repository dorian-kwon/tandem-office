import { openHwpForEdit, blankHwpForEdit, closeHwpSession, saveHwpSession } from './hwp-edit'
import type { HwpEditSession } from './hwp-edit'
import { ensureDom } from '../dom'
import { CliError, EXIT } from '../result'
import type { CommandContext } from '../registry'
import { loadLocalImage } from './markdown'
// @ts-expect-error The studio clipboard adapter is bundled JavaScript.
import { ieumSelectionHtml } from '../../../../apps/hwp/studio-plugin/clipboard-html.mjs'

export type HangulFormat = 'hwp' | 'hwpx'

async function writeHangul(session: HwpEditSession, target: HangulFormat, ctx: CommandContext) {
  const saved = await saveHwpSession(session, target)
  if (session.trackingDropped || saved.tailsLost || saved.memosLost) {
    ctx.warn({
      code: 'hangul_save_details',
      message: [
        session.trackingDropped && 'tracked changes were accepted',
        saved.tailsLost && 'some master page or memo data could not be carried over',
        saved.memosLost && `${saved.memosLost} memo(s) could not be carried over`,
      ]
        .filter(Boolean)
        .join('; '),
    })
  }
  return saved.bytes
}

export async function convertHangulNative(
  bytes: Uint8Array,
  target: HangulFormat,
  ctx: CommandContext,
) {
  const session = await openHwpForEdit(bytes)
  try {
    return await writeHangul(session, target, ctx)
  } finally {
    closeHwpSession(session)
  }
}

export async function hangulToHtml(bytes: Uint8Array): Promise<string> {
  const session = await openHwpForEdit(bytes)
  try {
    const { doc } = session
    const bridge = {
      exportSelectionHtml: doc.exportSelectionHtml.bind(doc),
      exportControlHtml: (section: number, para: number, control: number, path: string) =>
        doc.exportControlHtml(section, para, path, control),
      getControlTextPositions: (section: number, para: number) =>
        JSON.parse(doc.getControlTextPositions(section, para)),
      getParagraphLength: doc.getParagraphLength.bind(doc),
      getCellParagraphCountByPath: doc.getCellParagraphCountByPath.bind(doc),
      getCellParagraphLengthByPath: doc.getCellParagraphLengthByPath.bind(doc),
      exportSelectionInCellHtmlByPath: doc.exportSelectionInCellHtmlByPath.bind(doc),
    }
    const sections: string[] = []
    for (let section = 0; section < doc.getSectionCount(); section++) {
      const last = doc.getParagraphCount(section) - 1
      if (last < 0) continue
      const html: string = ieumSelectionHtml(
        bridge,
        section,
        0,
        0,
        last,
        doc.getParagraphLength(section, last),
      )
      const fragment = /<!--StartFragment-->([\s\S]*?)<!--EndFragment-->/.exec(html)
      if (!fragment) throw new CliError(EXIT.conversion, 'could not export Hangul body content')
      sections.push(fragment[1]!)
    }
    return (
      '<!doctype html><html><head><meta charset="utf-8"></head><body>' +
      sections.join('\n') +
      '</body></html>'
    )
  } finally {
    closeHwpSession(session)
  }
}

/** Feed the engine the same self-contained body it receives from the editor's clipboard. */
export async function htmlToHangul(
  html: string,
  input: string,
  target: HangulFormat,
  ctx: CommandContext,
) {
  await ensureDom()
  const body = new DOMParser().parseFromString(html, 'text/html').body
  body
    .querySelectorAll('script,style,template,iframe,object,embed')
    .forEach((node) => node.remove())
  let omittedImages = 0
  for (const image of body.querySelectorAll('img')) {
    const src = image.getAttribute('src') ?? ''
    if (/^data:image\/(png|jpe?g|gif|bmp);base64,/i.test(src)) continue
    const local = /^(?:[a-z]+:|[/\\]{2})/i.test(src)
      ? null
      : await loadLocalImage(src, { file: input, ctx })
    if (local) {
      image.setAttribute('src', 'data:' + local.mime + ';base64,' + local.base64)
    } else {
      image.replaceWith(body.ownerDocument.createTextNode(image.alt))
      omittedImages++
    }
  }
  if (omittedImages)
    ctx.warn({
      code: 'images_dropped',
      message: `${omittedImages} linked or unsupported image(s) were unavailable`,
    })
  const session = await blankHwpForEdit()
  try {
    if (body.innerHTML.trim()) {
      const pasted = JSON.parse(session.doc.pasteHtml(0, 0, 0, body.innerHTML))
      if (!pasted.ok)
        throw new CliError(EXIT.conversion, 'the Hangul engine could not import this document body')
    }
    return await writeHangul(session, target, ctx)
  } finally {
    closeHwpSession(session)
  }
}
