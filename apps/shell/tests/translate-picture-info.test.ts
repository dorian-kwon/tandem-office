import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createPictureInfo,
  countZipPictures,
  PICTURE_MIN_BYTES,
  pictureFamilyOf,
} from '../src/main/translate/picture-info'
import { createTranslateHandlers } from '../src/main/translate/translate-ipc'

/**
 * Pictures embedded in a source or reference (translate:picture-info): counted
 * read-only from the zip's central directory, never thrown, links not followed.
 */

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'translate-pictures-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** bytes that deflate badly, so a "large" picture stays large in the archive too */
function noise(size: number): Uint8Array {
  const out = new Uint8Array(size)
  let x = 12345
  for (let i = 0; i < size; i += 1) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    out[i] = x & 0xff
  }
  return out
}

async function zipOf(entries: Record<string, Uint8Array | string>): Promise<Buffer> {
  const zip = new JSZip()
  for (const [name, data] of Object.entries(entries)) zip.file(name, data)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

const BIG = PICTURE_MIN_BYTES + 1000

const IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'
const OLE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject'

function rels(list: { id: string; type?: string; target: string; external?: boolean }[]): string {
  return `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list
    .map(
      (r) =>
        `<Relationship Id="${r.id}" Type="${r.type ?? IMAGE}" Target="${r.target}"${
          r.external ? ' TargetMode="External"' : ''
        }/>`,
    )
    .join('')}</Relationships>`
}

/** a docx whose body places `body` media and whose first header places `header` media */
async function docxWith(body: string[], header: string[] = []): Promise<Buffer> {
  const entries: Record<string, Uint8Array | string> = {
    'word/document.xml': '<w:document/>',
    'word/_rels/document.xml.rels': rels(
      body.map((m, i) => ({ id: `rId${i}`, target: `media/${m}` })),
    ),
  }
  if (header.length) {
    entries['word/header1.xml'] = '<w:hdr/>'
    entries['word/_rels/header1.xml.rels'] = rels(
      header.map((m, i) => ({ id: `rId${i}`, target: `media/${m}` })),
    )
  }
  for (const m of [...body, ...header]) entries[`word/media/${m}`] = noise(BIG)
  return zipOf(entries)
}

describe('pictureFamilyOf', () => {
  it('knows the zip-based formats, and nothing else', () => {
    expect(pictureFamilyOf('a.docx')).toBe('docx')
    expect(pictureFamilyOf('a.PPTX')).toBe('pptx')
    expect(pictureFamilyOf('a.xlsm')).toBe('xlsx')
    expect(pictureFamilyOf('a.odp')).toBe('odf')
    expect(pictureFamilyOf('a.hwpx')).toBe('hwpx')
    expect(pictureFamilyOf('a.epub')).toBe('epub')
    for (const other of ['a.pdf', 'a.png', 'a.md', 'a.txt', 'a.hwp', 'a.doc', 'a.xls', 'a'])
      expect(pictureFamilyOf(other)).toBeNull()
  })
})

describe('countZipPictures', () => {
  it('a docx counts only media its body places, skipping tiny ones and non-pictures', async () => {
    const bytes = await zipOf({
      'word/document.xml': '<w:document/>',
      'word/_rels/document.xml.rels': rels([
        { id: 'rId1', target: 'media/image1.png' },
        { id: 'rId2', target: 'media/image2.jpeg' },
        { id: 'rId3', target: 'media/bullet.png' },
        { id: 'rId4', target: 'media/clip.mp4' },
        { id: 'rId5', target: 'http://example.com/a.png', external: true },
        { id: 'rId6', type: OLE, target: 'embeddings/x.bin' },
      ]),
      'word/media/image1.png': noise(BIG),
      'word/media/image2.jpeg': noise(BIG),
      'word/media/bullet.png': noise(200),
      'word/media/clip.mp4': noise(BIG),
      // a leftover nothing refers to
      'word/media/orphan.png': noise(BIG),
    })
    expect(await countZipPictures(bytes, 'a.docx')).toBe(2)
  })

  it('a docx with a picture only in a header counts it', async () => {
    expect(await countZipPictures(await docxWith([], ['logo.png']), 'a.docx')).toBe(1)
  })

  it('an equation or OLE preview in a docx does not count', async () => {
    const bytes = await zipOf({
      'word/document.xml':
        '<w:document><w:p><w:r><w:object><v:shape><v:imagedata r:id="rId1"/></v:shape><o:OLEObject r:id="rId2"/></w:object></w:r></w:p></w:document>',
      'word/_rels/document.xml.rels': rels([
        { id: 'rId1', target: 'media/image1.wmf' },
        { id: 'rId2', type: OLE, target: 'embeddings/oleObject1.bin' },
      ]),
      'word/media/image1.wmf': noise(BIG),
    })
    expect(await countZipPictures(bytes, 'a.docx')).toBe(0)
  })

  it('zero for a document without pictures', async () => {
    expect(await countZipPictures(await zipOf({ 'word/document.xml': '<x/>' }), 'a.docx')).toBe(0)
  })

  it('a pptx whose only media is a master or layout background counts nothing', async () => {
    const bytes = await zipOf({
      'ppt/slides/slide1.xml': '<p:sld/>',
      'ppt/slides/_rels/slide1.xml.rels': rels([
        {
          id: 'rId1',
          type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout',
          target: '../slideLayouts/slideLayout1.xml',
        },
      ]),
      'ppt/slideLayouts/slideLayout1.xml': '<p:sldLayout/>',
      'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels([
        { id: 'rId1', target: '../media/image1.png' },
      ]),
      'ppt/slideMasters/slideMaster1.xml': '<p:sldMaster/>',
      'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels([
        { id: 'rId1', target: '../media/image2.jpeg' },
      ]),
      'ppt/media/image1.png': noise(BIG),
      'ppt/media/image2.jpeg': noise(BIG),
    })
    expect(await countZipPictures(bytes, 'deck.pptx')).toBe(0)
  })

  it('a pptx counts pictures on slides and notes pages, not OLE previews', async () => {
    const bytes = await zipOf({
      'ppt/slides/slide1.xml':
        '<p:sld><p:pic><a:blip r:embed="rId1"/></p:pic><p:graphicFrame><p:oleObj r:id="rId3"><p:embed/><p:pic><a:blip r:embed="rId2"/></p:pic></p:oleObj></p:graphicFrame></p:sld>',
      'ppt/slides/_rels/slide1.xml.rels': rels([
        { id: 'rId1', target: '../media/image1.png' },
        { id: 'rId2', target: '../media/image2.emf' },
        { id: 'rId3', type: OLE, target: '../embeddings/oleObject1.bin' },
      ]),
      'ppt/notesSlides/notesSlide1.xml': '<p:notes/>',
      'ppt/notesSlides/_rels/notesSlide1.xml.rels': rels([
        { id: 'rId1', target: '../media/image3.png' },
      ]),
      'ppt/media/image1.png': noise(BIG),
      'ppt/media/image2.emf': noise(BIG),
      'ppt/media/image3.png': noise(BIG),
    })
    expect(await countZipPictures(bytes, 'deck.pptx')).toBe(2)
  })

  it('an xlsx counts the pictures of its drawings', async () => {
    const bytes = await zipOf({
      'xl/drawings/drawing1.xml': '<xdr:wsDr/>',
      'xl/drawings/_rels/drawing1.xml.rels': rels([{ id: 'rId1', target: '../media/image1.png' }]),
      'xl/media/image1.png': noise(BIG),
      'xl/media/unused.png': noise(BIG),
    })
    expect(await countZipPictures(bytes, 'a.xlsx')).toBe(1)
  })

  it('an ODF file counts Pictures/ links in content.xml, not in styles.xml', async () => {
    const bytes = await zipOf({
      'content.xml':
        '<office:document-content><draw:frame><draw:image xlink:href="Pictures/a.png"/></draw:frame><draw:frame><draw:object xlink:href="./Object 1"/><draw:image xlink:href="./ObjectReplacements/Object 1"/></draw:frame></office:document-content>',
      'styles.xml': '<draw:fill-image xlink:href="Pictures/bg.png"/>',
      'Pictures/a.png': noise(BIG),
      'Pictures/bg.png': noise(BIG),
    })
    expect(await countZipPictures(bytes, 'a.odt')).toBe(1)
  })

  it('an HWPX counts the binary items its sections refer to', async () => {
    const bytes = await zipOf({
      'Contents/content.hpf':
        '<opf:package><opf:manifest><opf:item id="image1" href="BinData/image1.png" media-type="image/png"/><opf:item id="image2" href="BinData/image2.png" media-type="image/png"/></opf:manifest></opf:package>',
      'Contents/section0.xml':
        '<hs:sec><hp:pic><hc:img binaryItemIDRef="image1"/></hp:pic></hs:sec>',
      'BinData/image1.png': noise(BIG),
      'BinData/image2.png': noise(BIG),
    })
    expect(await countZipPictures(bytes, 'a.hwpx')).toBe(1)
  })

  it('an epub counts image items anywhere', async () => {
    const bytes = await zipOf({
      mimetype: 'application/epub+zip',
      'OEBPS/images/a.jpg': noise(BIG),
      'OEBPS/cover.png': noise(BIG),
      'OEBPS/text.xhtml': '<html/>',
    })
    expect(await countZipPictures(bytes, 'book.epub')).toBe(2)
  })

  it('unknown (null) for bytes that are not a zip, or a type not covered', async () => {
    expect(
      await countZipPictures(new TextEncoder().encode('not a zip at all'), 'a.docx'),
    ).toBeNull()
    expect(await countZipPictures(new Uint8Array(0), 'a.docx')).toBeNull()
    expect(await countZipPictures(await docxWith(['a.png']), 'a.pdf')).toBeNull()
  })

  it('unknown for an archive with more entries than the cap', async () => {
    const entries: Record<string, string> = {}
    for (let i = 0; i < 30; i += 1) entries[`word/media/i${i}.png`] = 'x'
    expect(await countZipPictures(await zipOf(entries), 'a.docx', { maxEntries: 10 })).toBeNull()
  })

  it('unknown when a content part would inflate past the cap', async () => {
    const bytes = await zipOf({
      'word/document.xml': `<w:document>${' '.repeat(100_000)}</w:document>`,
      'word/_rels/document.xml.rels': rels([{ id: 'rId1', target: 'media/a.png' }]),
      'word/media/a.png': noise(BIG),
    })
    expect(await countZipPictures(bytes, 'a.docx')).toBe(1)
    expect(await countZipPictures(bytes, 'a.docx', { maxPartBytes: 10_000 })).toBeNull()
  })

  it('unknown for a central directory that points past the file', async () => {
    const bytes = await docxWith(['a.png'])
    // the end record's central-directory offset is its last-but-one field
    const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    bytes.writeUInt32LE(bytes.length + 100, eocd + 16)
    expect(await countZipPictures(bytes, 'a.docx')).toBeNull()
  })
})

describe('createPictureInfo', () => {
  function folders() {
    const dir = join(root, 'proj')
    mkdirSync(join(dir, 'source'), { recursive: true })
    mkdirSync(join(dir, 'references'), { recursive: true })
    return dir
  }

  it('counts a source and a reference; other kinds are unknown', async () => {
    const dir = folders()
    writeFileSync(join(dir, 'source', 'a.docx'), await docxWith(['p.png']))
    writeFileSync(
      join(dir, 'references', 'r.pptx'),
      await zipOf({
        'ppt/slides/slide1.xml': '<p:sld/>',
        'ppt/slides/_rels/slide1.xml.rels': rels([{ id: 'rId1', target: '../media/p.png' }]),
        'ppt/media/p.png': noise(BIG),
      }),
    )
    writeFileSync(join(dir, 'source', 'scan.pdf'), '%PDF-1.4')
    writeFileSync(join(dir, 'source', 'page.png'), noise(BIG))
    const info = createPictureInfo()
    expect(
      await info.forProject(dir, {
        sources: [
          { file: 'a.docx', sha256: 'h1', kind: 'editable' },
          { file: 'scan.pdf', sha256: 'h2', kind: 'scan' },
          { file: 'page.png', sha256: 'h3', kind: 'image' },
        ],
        references: ['r.pptx'],
      }),
    ).toEqual([
      { file: 'a.docx', kind: 'source', pictures: 1 },
      { file: 'scan.pdf', kind: 'source', pictures: null },
      { file: 'page.png', kind: 'source', pictures: null },
      { file: 'r.pptx', kind: 'reference', pictures: 1 },
    ])
  })

  it('never follows a linked file or folder out of the project', async () => {
    const dir = folders()
    const outside = join(root, 'outside.docx')
    writeFileSync(outside, await docxWith(['p.png']))
    symlinkSync(outside, join(dir, 'source', 'link.docx'))
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, 'r.docx'), await docxWith(['p.png']))
    rmSync(join(dir, 'references'), { recursive: true })
    symlinkSync(elsewhere, join(dir, 'references'))
    const got = await createPictureInfo().forProject(dir, {
      sources: [{ file: 'link.docx', sha256: 'h', kind: 'editable' }],
      references: ['r.docx'],
    })
    expect(got.map((g) => g.pictures)).toEqual([null, null])
  })

  it('a missing file, a broken file or a bad name is unknown, never an error', async () => {
    const dir = folders()
    writeFileSync(join(dir, 'source', 'broken.docx'), 'PK garbage')
    const got = await createPictureInfo().forProject(dir, {
      sources: [
        { file: 'gone.docx', sha256: 'h', kind: 'editable' },
        { file: 'broken.docx', sha256: 'h', kind: 'editable' },
        { file: '../project.json', sha256: 'h', kind: 'editable' },
      ],
      references: [],
    })
    expect(got.map((g) => g.pictures)).toEqual([null, null, null])
  })

  it('a file larger than the cap is unknown', async () => {
    const dir = folders()
    writeFileSync(join(dir, 'source', 'a.docx'), await docxWith(['p.png']))
    const got = await createPictureInfo({ maxFileBytes: 100 }).forProject(dir, {
      sources: [{ file: 'a.docx', sha256: 'h', kind: 'editable' }],
      references: [],
    })
    expect(got[0]?.pictures).toBeNull()
  })

  it('keeps the answer per file and hash until the file changes', async () => {
    const dir = folders()
    const path = join(dir, 'source', 'a.docx')
    writeFileSync(path, await docxWith(['p.png']))
    const when = new Date(1_700_000_000_000)
    utimesSync(path, when, when)
    const info = createPictureInfo()
    const lists = (sha256: string) => ({
      sources: [{ file: 'a.docx', sha256, kind: 'editable' as const }],
      references: [],
    })
    expect((await info.forProject(dir, lists('h1')))[0]?.pictures).toBe(1)
    // same size and time, same recorded hash: the kept answer, the file is not read again
    const { size } = statSync(path)
    writeFileSync(path, Buffer.alloc(size))
    utimesSync(path, when, when)
    expect((await info.forProject(dir, lists('h1')))[0]?.pictures).toBe(1)
    // a new recorded hash reads it again
    expect((await info.forProject(dir, lists('h2')))[0]?.pictures).toBeNull()
  })
})

describe('translate:picture-info handler', () => {
  it('refuses a folder that is not a registered project', async () => {
    const h = createTranslateHandlers({
      settingsPath: () => join(root, 'app-settings.json'),
      now: () => 1,
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    })
    await expect(h.pictureInfo(join(root, 'nowhere'))).rejects.toMatchObject({
      code: 'NOT_REGISTERED',
    })
  })
})
