import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDocx, TINY_PNG_BASE64 } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { listEmbeddedImages } from '../src/main/translate/embedded-images'
import { orderByPlaces } from '../src/main/translate/picture-order'

/**
 * The pictures of a Word document are listed in the order they stand in the document, each with
 * the page it is on when that can be known. Word writes where each page began
 * (`w:lastRenderedPageBreak`) when it saves; a document made without it still has its hard page
 * breaks. Anything else is unknown, and an unknown page is left out rather than guessed.
 */

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'
const rel = (id: string, name: string) =>
  `<Relationship Id="${id}" Type="${REL}" Target="media/${name}"/>`
const png = (name: string) => ({
  path: `word/media/${name}`,
  base64: TINY_PNG_BASE64,
  extension: 'png',
  contentType: 'image/png',
})
const picture = (id: string) =>
  `<w:r><w:drawing><wp:inline><wp:extent cx="900000" cy="900000"/><wp:docPr id="${id.length}" name="P"/>` +
  `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>` +
  `<pic:blipFill><a:blip r:embed="${id}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic>` +
  `</wp:inline></w:drawing></w:r>`
const para = (...inner: string[]) => `<w:p>${inner.join('')}</w:p>`
const text = (value: string) => `<w:r><w:t>${value}</w:t></w:r>`
const renderedBreak = '<w:r><w:lastRenderedPageBreak/></w:r>'
const hardBreak = '<w:r><w:br w:type="page"/></w:r>'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function listed(bodyXml: string, names: string[]) {
  const bytes = await buildDocx({
    extraRels: names.map((n, i) => rel(`rIdPic${i + 1}`, n)).join(''),
    binaryParts: names.map(png),
    bodyXml,
  })
  const dir = await mkdtemp(join(tmpdir(), 'ieum-pages-'))
  dirs.push(dir)
  const path = join(dir, 'doc.docx')
  await writeFile(path, bytes)
  return listEmbeddedImages(path)
}
const pagesOf = (images: { page?: number | undefined }[]) => images.map((i) => i.page)

describe('the page of each picture of a Word document', () => {
  it('counts the pages Word wrote down, and says they are exact', async () => {
    const images = await listed(
      para(text('one'), picture('rIdPic1')) +
        para(renderedBreak, text('two')) +
        para(picture('rIdPic2')) +
        para(renderedBreak, picture('rIdPic3')),
      ['a.png', 'b.png', 'c.png'],
    )
    expect(images.map((i) => i.name)).toEqual(['a.png', 'b.png', 'c.png'])
    expect(pagesOf(images)).toEqual([1, 2, 3])
    expect(images.some((i) => i.pageApprox)).toBe(false)
  })

  it('falls back to hard page breaks and says the page may be later than counted', async () => {
    const images = await listed(
      para(picture('rIdPic1')) + para(hardBreak) + para(picture('rIdPic2')),
      ['a.png', 'b.png'],
    )
    expect(pagesOf(images)).toEqual([1, 2])
    expect(images.every((i) => i.pageApprox === true)).toBe(true)
  })

  it('counts a paragraph that starts on a new page', async () => {
    const images = await listed(
      para(picture('rIdPic1')) +
        '<w:p><w:pPr><w:pageBreakBefore/></w:pPr>' +
        picture('rIdPic2') +
        '</w:p>',
      ['a.png', 'b.png'],
    )
    expect(pagesOf(images)).toEqual([1, 2])
  })

  it('leaves the page out when nothing in the file says where pages begin', async () => {
    const images = await listed(para(picture('rIdPic1')) + para(picture('rIdPic2')), [
      'a.png',
      'b.png',
    ])
    expect(pagesOf(images)).toEqual([undefined, undefined])
  })

  it('does not give a page to a picture of a header, which is on every page', async () => {
    const bytes = await buildDocx({
      binaryParts: [png('mark.png')],
      extraParts: [
        {
          path: 'word/header1.xml',
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml',
          xml:
            '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
            'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
            'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
            'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
            `<w:p>${picture('rId1')}</w:p></w:hdr>`,
        },
        {
          path: 'word/_rels/header1.xml.rels',
          contentType: 'application/vnd.openxmlformats-package.relationships+xml',
          xml: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel('rId1', 'mark.png')}</Relationships>`,
        },
      ],
      bodyXml: para(text('Body'), renderedBreak),
    })
    const dir = await mkdtemp(join(tmpdir(), 'ieum-pages-'))
    dirs.push(dir)
    const path = join(dir, 'doc.docx')
    await writeFile(path, bytes)
    const images = await listEmbeddedImages(path)
    expect(images.map((i) => i.name)).toEqual(['mark.png'])
    expect(images[0]!.page).toBeUndefined()
  })
})

describe('putting pictures in the order of the laid-out pages', () => {
  const places = [
    { page: 1, y: 0, x: 0, sha256: 'b' },
    { page: 3, y: 0, x: 0, sha256: 'a' },
  ]

  it('puts the pictures the layout knows first, in page order, and the others after in their own order', () => {
    const ordered = orderByPlaces(['A', 'B', 'C', 'D'], ['a', 'b', 'c', 'd'], places)
    expect(ordered.map((o) => o.image)).toEqual(['B', 'A', 'C', 'D'])
    expect(ordered.map((o) => o.page)).toEqual([1, 3, undefined, undefined])
  })

  it('keeps the listed order when the layout knows none of them', () => {
    const ordered = orderByPlaces(['A', 'B'], ['x', 'y'], places)
    expect(ordered.map((o) => o.image)).toEqual(['A', 'B'])
    expect(ordered.every((o) => o.page === undefined)).toBe(true)
  })

  it('treats two stored pictures that are the same bytes as one place, the first taking it', () => {
    const ordered = orderByPlaces(['A', 'B'], ['a', 'a'], places)
    expect(ordered.map((o) => o.page)).toEqual([3, undefined])
  })
})

const root = join(__dirname, '..', '..', '..')
const real = async (name: string, ...path: string[]) => {
  const dir = await mkdtemp(join(tmpdir(), 'ieum-pages-'))
  dirs.push(dir)
  const target = join(dir, name)
  await writeFile(target, readFileSync(join(root, ...path)))
  return listEmbeddedImages(target)
}

describe('the page of a picture of a Hangul document', () => {
  it('comes from the engine for a HWPX document', async () => {
    const images = await real(
      'doc.hwpx',
      'apps/hwp/tests/fixtures/square-picture-after-page-reset.hwpx',
    )
    expect(pagesOf(images)).toEqual([2])
    expect(images[0]!.pageApprox).toBeUndefined()
  })

  it('comes from the engine for a HWP 5 document', async () => {
    const images = await real('doc.hwp', 'e2e/assets/hwp-picture-table.hwp')
    expect(pagesOf(images)).toEqual([1])
  })
})
