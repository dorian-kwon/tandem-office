import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { buildDocx, TINY_PNG_BASE64 } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { listEmbeddedImages } from '../src/main/translate/embedded-images'
import { placeOcrText } from '../src/main/translate/ocr-placement'

/**
 * Every picture of a Word document is an OCR target, wherever it sits: in a table cell, inside a
 * text box, behind the text, as the fill of a shape, as the page background, or as a header
 * watermark. The listing walks the whole document, not just the pictures that stand alone in the
 * body.
 */

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'
const rel = (id: string, name: string, base = '') =>
  `<Relationship Id="${id}" Type="${REL}" Target="${base}media/${name}"/>`
const png = (name: string) => ({
  path: `word/media/${name}`,
  base64: TINY_PNG_BASE64,
  extension: 'png',
  contentType: 'image/png',
})
const inlinePicture = (id: string) =>
  `<w:r><w:drawing><wp:inline><wp:extent cx="900000" cy="900000"/><wp:docPr id="${id.length}" name="P"/>` +
  `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>` +
  `<pic:blipFill><a:blip r:embed="${id}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic>` +
  `</wp:inline></w:drawing></w:r>`

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function list(bytes: Uint8Array) {
  const dir = await mkdtemp(join(tmpdir(), 'ieum-embedded-'))
  dirs.push(dir)
  const path = join(dir, 'doc.docx')
  await writeFile(path, bytes)
  return listEmbeddedImages(path)
}
const namesOf = async (bytes: Uint8Array) => (await list(bytes)).map((i) => i.name).sort()

async function pageBackgroundDocument(): Promise<Uint8Array> {
  const source = await buildDocx({
    extraRels: rel('rIdPageBg', 'page-background.png'),
    binaryParts: [png('page-background.png')],
    bodyXml: '<w:p><w:r><w:t>Body</w:t></w:r></w:p>',
  })
  const zip = await JSZip.loadAsync(source)
  const xml = await zip.file('word/document.xml')!.async('string')
  zip.file(
    'word/document.xml',
    xml.replace(
      '<w:body>',
      '<w:background w:color="FFFFFF" xmlns:v="urn:schemas-microsoft-com:vml" ' +
        'xmlns:o="urn:schemas-microsoft-com:office:office"><v:background id="_x0000_s1025" o:bwmode="white">' +
        '<v:fill r:id="rIdPageBg" o:title="" recolor="t" rotate="t" type="frame"/></v:background></w:background><w:body>',
    ),
  )
  return zip.generateAsync({ type: 'uint8array' })
}

describe('pictures the OCR listing finds in a Word document', () => {
  it('finds a picture in a table cell, in a nested table and in a text box', async () => {
    const textBox =
      '<w:p><w:r><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
      '<mc:Choice Requires="wps"><w:drawing><wp:anchor><wp:extent cx="1" cy="1"/><wp:docPr id="40" name="TB"/>' +
      '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
      '<wps:wsp xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:txbx><w:txbxContent>' +
      `<w:p>${inlinePicture('rIdTextBox')}</w:p></w:txbxContent></wps:txbx></wps:wsp>` +
      '</a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice></mc:AlternateContent></w:r></w:p>'
    const bytes = await buildDocx({
      extraRels:
        rel('rIdCell', 'in-cell.png') +
        rel('rIdNested', 'in-nested.png') +
        rel('rIdTextBox', 'in-textbox.png'),
      binaryParts: [png('in-cell.png'), png('in-nested.png'), png('in-textbox.png')],
      bodyXml:
        '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc>' +
        `<w:p>${inlinePicture('rIdCell')}</w:p>` +
        '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:tc>' +
        `<w:p>${inlinePicture('rIdNested')}</w:p></w:tc></w:tr></w:tbl><w:p/></w:tc></w:tr></w:tbl>` +
        textBox,
    })
    expect(await namesOf(bytes)).toEqual(['in-cell.png', 'in-nested.png', 'in-textbox.png'])
  })

  it('keeps real Word paragraph anchors around a nested text box and a drawing paragraph', async () => {
    const bytes = await buildDocx({
      extraRels:
        rel('rIdInner', 'inner.png') + rel('rIdOuter', 'outer.png') + rel('rIdCell', 'cell.png'),
      binaryParts: [png('inner.png'), png('outer.png'), png('cell.png')],
      bodyXml:
        '<w:p><w:r><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml"><v:textbox><w:txbxContent>' +
        '<w:p>' +
        inlinePicture('rIdInner') +
        '</w:p></w:txbxContent></v:textbox></v:shape></w:pict></w:r>' +
        inlinePicture('rIdOuter') +
        '</w:p><w:p><w:r><w:drawing><a:txBody><a:p/></a:txBody></w:drawing></w:r></w:p>' +
        '<w:tbl><w:tr><w:tc><w:tbl><w:tr><w:tc><w:p>' +
        inlinePicture('rIdCell') +
        '</w:p></w:tc></w:tr></w:tbl><w:p/></w:tc></w:tr></w:tbl>',
    })
    const images = await list(bytes)
    expect(images.map((i) => [i.relId, i.location])).toEqual([
      ['rIdInner', 'document.xml · ¶2'],
      ['rIdOuter', 'document.xml · ¶1'],
      ['rIdCell', 'document.xml · ¶4'],
    ])
  })

  it('finds a picture behind the text and the picture fill of a shape', async () => {
    const behind =
      '<w:p><w:r><w:drawing><wp:anchor behindDoc="1"><wp:extent cx="1" cy="1"/><wp:docPr id="50" name="BG"/>' +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>' +
      '<pic:blipFill><a:blip r:embed="rIdBehind"/></pic:blipFill></pic:pic></a:graphicData></a:graphic>' +
      '</wp:anchor></w:drawing></w:r></w:p>'
    const shapeFill =
      '<w:p><w:r><w:drawing><wp:anchor><wp:extent cx="1" cy="1"/><wp:docPr id="51" name="SH"/>' +
      '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
      '<wps:wsp xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:spPr>' +
      '<a:blipFill><a:blip r:embed="rIdFill"/></a:blipFill></wps:spPr></wps:wsp>' +
      '</a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p>'
    const bytes = await buildDocx({
      extraRels: rel('rIdBehind', 'behind.png') + rel('rIdFill', 'shape-fill.png'),
      binaryParts: [png('behind.png'), png('shape-fill.png')],
      bodyXml: behind + shapeFill,
    })
    expect(await namesOf(bytes)).toEqual(['behind.png', 'shape-fill.png'])
  })

  it('finds the picture of the page background', async () => {
    expect(await namesOf(await pageBackgroundDocument())).toEqual(['page-background.png'])
  })

  it('places the text read from the page background without touching the background', async () => {
    const bytes = await pageBackgroundDocument()
    const [image] = await list(bytes)
    const out = await placeOcrText(
      bytes,
      'docx',
      [
        {
          index: 1,
          text: 'BACKGROUND WORDS',
          location: image!.location,
          part: image!.part,
          relId: image!.relId,
        },
      ],
      { kind: 'docx-after-images' },
    )
    const xml = await (await JSZip.loadAsync(out)).file('word/document.xml')!.async('string')
    expect(xml).toContain('BACKGROUND WORDS')
    expect(xml).toContain('<v:fill r:id="rIdPageBg"')
  })

  it('finds a header watermark picture', async () => {
    const bytes = await buildDocx({
      binaryParts: [png('watermark.png')],
      extraParts: [
        {
          path: 'word/header1.xml',
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml',
          xml:
            '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
            'xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">' +
            '<w:p><w:r><w:pict><v:shape id="WaterMark" type="#_x0000_t75"><v:imagedata r:id="rId1" o:title="mark"/></v:shape></w:pict></w:r></w:p></w:hdr>',
        },
        {
          path: 'word/_rels/header1.xml.rels',
          contentType: 'application/vnd.openxmlformats-package.relationships+xml',
          xml: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel('rId1', 'watermark.png', '')}</Relationships>`,
        },
      ],
      bodyXml: '<w:p><w:r><w:t>Body</w:t></w:r></w:p>',
    })
    expect(await namesOf(bytes)).toEqual(['watermark.png'])
  })

  it('lists a picture once even when a text box carries it twice (drawing and VML fallback)', async () => {
    const both =
      '<w:p><w:r><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
      'xmlns:v="urn:schemas-microsoft-com:vml">' +
      `<mc:Choice Requires="wps"><w:drawing>${inlinePicture('rIdTwice').replace('<w:r><w:drawing>', '').replace('</w:drawing></w:r>', '')}</w:drawing></mc:Choice>` +
      '<mc:Fallback><w:pict><v:shape><v:imagedata r:id="rIdTwice"/></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>'
    const bytes = await buildDocx({
      extraRels: rel('rIdTwice', 'twice.png'),
      binaryParts: [png('twice.png')],
      bodyXml: both,
    })
    expect(await namesOf(bytes)).toEqual(['twice.png'])
  })
})
