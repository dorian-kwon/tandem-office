import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { build } from 'esbuild'
import { buildDocx, TINY_PNG_BASE64 } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { listEmbeddedImages } from '../src/main/translate/embedded-images'
import { locatePictures, placeOcrIntoOpenDocx } from '../src/main/translate/ocr-docx-placement'

/**
 * OCR text put into the Word document that is open. The listing of its pictures was made from a
 * copy, and the open document may have changed since (paragraphs added before a picture), so a
 * picture is found again by its relationship id in the bytes at hand, never by the paragraph
 * number the listing gave.
 */

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'
const picture = (id: string) =>
  `<w:r><w:drawing><wp:inline><wp:extent cx="3000000" cy="1500000"/><wp:docPr id="${id.length}" name="P"/>` +
  `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>` +
  `<pic:blipFill><a:blip r:embed="${id}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic>` +
  `</wp:inline></w:drawing></w:r>`
const text = (value: string) => `<w:p><w:r><w:t>${value}</w:t></w:r></w:p>`
const png = (name: string) => ({
  path: `word/media/${name}`,
  base64: TINY_PNG_BASE64,
  extension: 'png',
  contentType: 'image/png',
})
const BOX = { x: 0.1, y: 0.2, w: 0.3, h: 0.1, fontHeight: 0.08, text: 'Shop name' }

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function docx(bodyXml: string, ids: string[]): Promise<Uint8Array> {
  return buildDocx({
    extraRels: ids
      .map((id, i) => `<Relationship Id="${id}" Type="${REL}" Target="media/p${i}.png"/>`)
      .join(''),
    binaryParts: ids.map((_, i) => png(`p${i}.png`)),
    bodyXml,
  })
}
const bodyOf = async (bytes: Uint8Array) =>
  (await (await JSZip.loadAsync(bytes)).file('word/document.xml')!.async('string')) as string

describe('finding a picture again by its relationship id', () => {
  it('numbers the paragraph of each picture the way the listing does', async () => {
    const bytes = await docx(
      text('one') + `<w:p>${picture('rIdA')}</w:p>` + text('two') + `<w:p>${picture('rIdB')}</w:p>`,
      ['rIdA', 'rIdB'],
    )
    const dir = await mkdtemp(join(tmpdir(), 'ieum-live-'))
    dirs.push(dir)
    const path = join(dir, 'doc.docx')
    await writeFile(path, bytes)
    const listed = await listEmbeddedImages(path)
    const located = locatePictures(await bodyOf(bytes))
    for (const image of listed)
      expect(image.location).toBe(`document.xml · ¶${located.get(image.relId)}`)
  })

  it('knows the first place of a picture that stands twice', () => {
    const xml = `<w:body>${text('a')}<w:p>${picture('rIdA')}</w:p><w:p>${picture('rIdA')}</w:p></w:body>`
    expect(locatePictures(xml).get('rIdA')).toBe(2)
  })
})

describe('placing into the bytes of the open document', () => {
  const item = (relId: string, index = 1, location = 'document.xml · ¶2') => ({
    index,
    text: 'Shop name',
    location,
    part: 'word/document.xml',
    relId,
  })

  it('puts the boxes after the picture even when paragraphs were added before it', async () => {
    // the listing said paragraph 2; the open document has two more paragraphs in front now
    const live = await docx(
      text('added 1') +
        text('added 2') +
        text('one') +
        `<w:p>${picture('rIdA')}</w:p>` +
        text('end'),
      ['rIdA'],
    )
    const result = await placeOcrIntoOpenDocx(live, [item('rIdA')], {
      kind: 'docx-image-boxes',
      images: [{ index: 1, boxes: [BOX] }],
    })
    expect(result.placed).toEqual([1])
    expect(result.skipped).toEqual([])
    const xml = await bodyOf(result.bytes)
    const at = xml.indexOf('Shop name')
    expect(at).toBeGreaterThan(xml.indexOf('rIdA'))
    expect(at).toBeLessThan(xml.indexOf('>end<'))
    // the picture and its relationship are untouched
    expect(xml).toContain('r:embed="rIdA"')
  })

  it('leaves out a picture that is no longer in the document and places the others', async () => {
    const live = await docx(`<w:p>${picture('rIdB')}</w:p>`, ['rIdB'])
    const result = await placeOcrIntoOpenDocx(
      live,
      [item('rIdA', 1), item('rIdB', 2, 'document.xml · ¶9')],
      {
        kind: 'docx-image-boxes',
        images: [
          { index: 1, boxes: [BOX] },
          { index: 2, boxes: [{ ...BOX, text: 'Other' }] },
        ],
      },
    )
    expect(result.placed).toEqual([2])
    expect(result.skipped).toEqual([1])
    const xml = await bodyOf(result.bytes)
    expect(xml).toContain('Other')
    expect(xml).not.toContain('Shop name')
  })

  it('places plain text after the picture for the list placement', async () => {
    const live = await docx(text('x') + `<w:p>${picture('rIdA')}</w:p>` + text('end'), ['rIdA'])
    const result = await placeOcrIntoOpenDocx(live, [item('rIdA')], { kind: 'docx-after-images' })
    const xml = await bodyOf(result.bytes)
    expect(xml.indexOf('Shop name')).toBeGreaterThan(xml.indexOf('rIdA'))
  })

  it('refuses a placement that points into tables of a document that may have changed', async () => {
    const live = await docx(`<w:p>${picture('rIdA')}</w:p>`, ['rIdA'])
    await expect(
      placeOcrIntoOpenDocx(live, [item('rIdA')], {
        kind: 'docx-table-cell',
        table: 1,
        row: 1,
        column: 1,
        overwrite: false,
      }),
    ).rejects.toThrow(/table/i)
  })

  it('refuses when no picture of the reading is left', async () => {
    const live = await docx(text('only text'), [])
    await expect(
      placeOcrIntoOpenDocx(live, [item('rIdA')], { kind: 'docx-after-images' }),
    ).rejects.toThrow(/picture/i)
  })
})

describe('the module runs in the editor window', () => {
  it('bundles for a browser: nothing in it needs Node', async () => {
    const result = await build({
      entryPoints: [join(__dirname, '../src/main/translate/ocr-docx-placement.ts')],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      logLevel: 'silent',
    })
    expect(result.errors).toEqual([])
    expect(result.outputFiles[0]!.text.length).toBeGreaterThan(1000)
  })
})
