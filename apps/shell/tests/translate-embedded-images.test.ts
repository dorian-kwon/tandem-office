import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { listEmbeddedImages, readEmbeddedImage } from '../src/main/translate/embedded-images'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'embedded-ocr-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(3000, 1)])
const rel = (id: string, target: string, external = false) =>
  `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"${external ? ' TargetMode="External"' : ''}/>`
async function archive(name: string, parts: Record<string, string | Uint8Array>) {
  const zip = new JSZip()
  for (const [key, value] of Object.entries(parts)) zip.file(key, value)
  const path = join(dir, name)
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  return path
}
it('lists placed DOCX images in reading order, once, excluding orphan, external and OLE pictures', async () => {
  const path = await archive('a.docx', {
    'word/document.xml':
      '<w:document><w:p><a:blip r:embed="b"/></w:p><w:p><a:blip r:embed="a"/><a:blip r:embed="b"/><a:blip r:link="remote"/><w:object><v:imagedata r:id="ole"/></w:object></w:p></w:document>',
    'word/_rels/document.xml.rels': `<Relationships>${rel('a', 'media/a.png')}${rel('b', 'media/b.png')}${rel('remote', 'https://example.com/a.png', true)}${rel('ole', 'media/ole.png')}</Relationships>`,
    'word/media/a.png': png,
    'word/media/b.png': png,
    'word/media/orphan.png': png,
    'word/media/ole.png': png,
  })
  const items = await listEmbeddedImages(path)
  expect(items.map((x) => x.name)).toEqual(['b.png', 'a.png'])
  expect(items.map((x) => x.location)).toEqual(['document.xml · ¶1', 'document.xml · ¶2'])
  expect(await readEmbeddedImage(path, items[1]!)).toEqual({
    data: new Uint8Array(png),
    mime: 'image/png',
  })
})
it('resolves workbook sheet order and drawing anchors into cell locations', async () => {
  const path = await archive('a.xlsx', {
    'xl/workbook.xml':
      '<workbook><sheets><sheet name="Second &amp; sheet" r:id="s2"/><sheet name="First" r:id="s1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="s1" Target="worksheets/sheet1.xml"/><Relationship Id="s2" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/worksheets/sheet2.xml': '<worksheet><drawing r:id="d"/></worksheet>',
    'xl/worksheets/_rels/sheet2.xml.rels':
      '<Relationships><Relationship Id="d" Target="../drawings/drawing1.xml"/></Relationships>',
    'xl/drawings/drawing1.xml':
      '<xdr:wsDr><xdr:twoCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:row>4</xdr:row></xdr:from><xdr:pic><a:blip r:embed="im"/></xdr:pic></xdr:twoCellAnchor></xdr:wsDr>',
    'xl/drawings/_rels/drawing1.xml.rels': `<Relationships>${rel('im', '../media/image1.png')}</Relationships>`,
    'xl/media/image1.png': png,
  })
  const items = await listEmbeddedImages(path)
  expect(items).toHaveLength(1)
  expect(items[0]!.location).toBe('Second & sheet · B5')
})
it('refuses unsupported documents, corrupt ZIPs and a changed archive when serving a listed image', async () => {
  await expect(listEmbeddedImages(join(dir, 'a.pptx'))).rejects.toThrow()
  const bad = join(dir, 'bad.docx')
  await writeFile(bad, 'not a ZIP')
  await expect(listEmbeddedImages(bad)).rejects.toThrow()
  const path = await archive('a.docx', {
    'word/document.xml': '<w:p><a:blip r:embed="i"/></w:p>',
    'word/_rels/document.xml.rels': `<Relationships>${rel('i', 'media/a.png')}</Relationships>`,
    'word/media/a.png': png,
  })
  const [item] = await listEmbeddedImages(path)
  await writeFile(path, 'changed')
  await expect(readEmbeddedImage(path, item!)).rejects.toThrow()
})

it('caps actual image inflation even when the ZIP declares a smaller image', async () => {
  const path = await archive('a.docx', {
    'word/document.xml': '<w:p><a:blip r:embed="i"/></w:p>',
    'word/_rels/document.xml.rels': `<Relationships>${rel('i', 'media/a.png')}</Relationships>`,
    'word/media/a.png': png,
  })
  const bytes = await readFile(path)
  for (let at = 0; at < bytes.length - 46; at++) {
    if (bytes.readUInt32LE(at) !== 0x02014b50) continue
    const name = bytes.subarray(at + 46, at + 46 + bytes.readUInt16LE(at + 28)).toString()
    if (name === 'word/media/a.png') {
      bytes.writeUInt32LE(2048, at + 24)
      break
    }
  }
  await writeFile(path, bytes)
  const [item] = await listEmbeddedImages(path)
  await expect(readEmbeddedImage(path, item!)).rejects.toThrow()
})

it('includes small referenced images rather than hiding them as decorations', async () => {
  const tiny = png.subarray(0, 200)
  const path = await archive('a.docx', {
    'word/document.xml': '<w:p><a:blip r:embed="i"/></w:p>',
    'word/_rels/document.xml.rels': `<Relationships>${rel('i', 'media/a.png')}</Relationships>`,
    'word/media/a.png': tiny,
  })
  const items = await listEmbeddedImages(path)
  expect(items).toHaveLength(1)
  expect((await readEmbeddedImage(path, items[0]!)).data).toEqual(new Uint8Array(tiny))
})
