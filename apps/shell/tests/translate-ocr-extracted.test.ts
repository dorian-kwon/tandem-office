import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import JSZip from 'jszip'
import * as CFB from 'cfb'
import { TINY_PNG_BASE64 } from '../../../packages/docx-engine/tests/helpers/build-docx'
import {
  listEmbeddedImages,
  readEmbeddedImage,
  supportsEmbeddedOcr,
  supportsExtractedOcr,
} from '../src/main/translate/embedded-images'

/**
 * Pictures of a Hangul document (HWPX is a zip with BinData and manifest, HWP is a compound
 * file with BinData streams) are listed so OCR can read them. The result goes into a new Word
 * document, so nothing here writes into the Hangul file.
 */

const PNG = Buffer.from(TINY_PNG_BASE64, 'base64')
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])

/** the bytes are the same, whatever kind of typed array carries them */
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b))

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function save(name: string, bytes: Uint8Array): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ieum-extracted-'))
  dirs.push(dir)
  const path = join(dir, name)
  await writeFile(path, bytes)
  return path
}

describe('which formats the picture listing takes', () => {
  it('keeps docx and xlsx as embedded and takes the Hangul formats as extracted', () => {
    expect(supportsEmbeddedOcr('a.docx')).toBe(true)
    expect(supportsEmbeddedOcr('a.hwpx')).toBe(false)
    expect(supportsExtractedOcr('a.hwpx')).toBe(true)
    expect(supportsExtractedOcr('A.HWP')).toBe(true)
    expect(supportsExtractedOcr('a.docx')).toBe(false)
    expect(supportsExtractedOcr('a.doc')).toBe(false)
  })
})

const NS =
  'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" ' +
  'xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head"'
const pic = (id: string) => `<hp:pic><hc:img binaryItemIDRef="${id}" bright="0"/></hp:pic>`

async function hwpx(): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('mimetype', 'application/hwp+zip')
  zip.file(
    'Contents/content.hpf',
    '<opf:package xmlns:opf="http://www.idpf.org/2007/opf/"><opf:manifest>' +
      '<opf:item id="image1" href="BinData/image1.png" media-type="image/png" isEmbeded="1"/>' +
      '<opf:item id="image2" href="BinData/image2.jpg" media-type="image/jpg" isEmbeded="1"/>' +
      '<opf:item id="bg" href="BinData/background.png" media-type="image/png" isEmbeded="1"/>' +
      '<opf:item id="unused" href="BinData/unused.png" media-type="image/png" isEmbeded="1"/>' +
      '<opf:item id="shape" href="BinData/shape.bmp" media-type="image/bmp" isEmbeded="1"/>' +
      '</opf:manifest></opf:package>',
  )
  zip.file(
    'Contents/section0.xml',
    `<hs:sec ${NS}><hp:p><hp:run>${pic('image1')}</hp:run></hp:p>` +
      `<hp:p><hp:run><hp:tbl><hp:tr><hp:tc><hp:subList><hp:p><hp:run>${pic('image2')}</hp:run></hp:p></hp:subList></hp:tc></hp:tr></hp:tbl></hp:run></hp:p>` +
      `<hp:p><hp:run>${pic('image1')}</hp:run></hp:p><hp:p><hp:run>${pic('shape')}</hp:run></hp:p></hs:sec>`,
  )
  zip.file(
    'Contents/header.xml',
    `<hh:head ${NS}><hh:refList><hh:borderFills><hh:borderFill><hc:fillBrush><hc:imgBrush mode="TILE">` +
      '<hc:img binaryItemIDRef="bg"/></hc:imgBrush></hc:fillBrush></hh:borderFill></hh:borderFills></hh:refList></hh:head>',
  )
  zip.file('BinData/image1.png', PNG)
  zip.file('BinData/image2.jpg', JPEG)
  zip.file('BinData/background.png', PNG)
  zip.file('BinData/unused.png', PNG)
  zip.file('BinData/shape.bmp', Buffer.from('BM-not-readable-by-the-AI'))
  return zip.generateAsync({ type: 'uint8array' })
}

describe('pictures of a HWPX document', () => {
  it('lists each referenced picture once: body, table cells, then the background fill', async () => {
    const images = await listEmbeddedImages(await save('doc.hwpx', await hwpx()))
    expect(images.map((i) => [i.name, i.location])).toEqual([
      ['image1.png', 'section0.xml'],
      ['image2.jpg', 'section0.xml'],
      ['background.png', 'header.xml'],
    ])
  })

  it('leaves out a picture nothing refers to and a format the AI cannot read', async () => {
    const names = (await listEmbeddedImages(await save('doc.hwpx', await hwpx()))).map(
      (i) => i.name,
    )
    expect(names).not.toContain('unused.png')
    expect(names).not.toContain('shape.bmp')
  })

  it('reads the picture bytes with their type', async () => {
    const path = await save('doc.hwpx', await hwpx())
    const [first, second] = await listEmbeddedImages(path)
    const read = await readEmbeddedImage(path, first!)
    expect(read.mime).toBe('image/png')
    expect(sameBytes(read.data, PNG)).toBe(true)
    expect((await readEmbeddedImage(path, second!)).mime).toBe('image/jpeg')
  })
})

function hwpHeader(flags: number): Buffer {
  const header = Buffer.alloc(256)
  header.write('HWP Document File', 0, 'latin1')
  header.writeUInt32LE(0x05010000, 32)
  header.writeUInt32LE(flags, 36)
  return header
}
function hwp(flags: number, streams: Record<string, Buffer>): Uint8Array {
  const cfb = CFB.utils.cfb_new()
  CFB.utils.cfb_add(cfb, '/FileHeader', hwpHeader(flags))
  CFB.utils.cfb_add(cfb, '/DocInfo', Buffer.from('docinfo'))
  for (const [path, bytes] of Object.entries(streams)) CFB.utils.cfb_add(cfb, path, bytes)
  return new Uint8Array(CFB.write(cfb, { type: 'buffer' }) as Buffer)
}

describe('pictures of a HWP document', () => {
  it('lists the BinData pictures in order and reads them, deflated or not', async () => {
    // the document says its streams are deflated; one picture is stored as it is
    const bytes = hwp(0x1, {
      '/BinData/BIN0001.png': deflateRawSync(PNG),
      '/BinData/BIN0002.jpg': JPEG,
      '/BinData/BIN0003.ole': Buffer.from('not a picture'),
    })
    const path = await save('doc.hwp', bytes)
    const images = await listEmbeddedImages(path)
    expect(images.map((i) => i.name)).toEqual(['BIN0001.png', 'BIN0002.jpg'])
    const png = await readEmbeddedImage(path, images[0]!)
    const jpeg = await readEmbeddedImage(path, images[1]!)
    expect([png.mime, jpeg.mime]).toEqual(['image/png', 'image/jpeg'])
    expect(sameBytes(png.data, PNG)).toBe(true)
    expect(sameBytes(jpeg.data, JPEG)).toBe(true)
  })

  it('reads a large contiguous picture by range and rejects a changed source', async () => {
    const picture = Buffer.alloc(8 * 1024 * 1024, 0x40)
    JPEG.copy(picture)
    const path = await save('large.hwp', hwp(0, { '/BinData/BIN0001.jpg': picture }))
    const [image] = await listEmbeddedImages(path)
    expect(image!.hwpStream).toMatchObject({ length: picture.length, offset: expect.any(Number) })
    expect(sameBytes((await readEmbeddedImage(path, image!)).data, picture)).toBe(true)
    await writeFile(path, hwp(0, { '/BinData/BIN0001.jpg': JPEG }))
    await expect(readEmbeddedImage(path, image!)).rejects.toThrow(/changed/)
  })

  it('reads fragmented FAT streams in their logical order', async () => {
    const sectorSize = 512
    const picture = Buffer.alloc(8192)
    for (let at = 0; at < picture.length; at++) picture[at] = Math.floor(at / sectorSize)
    JPEG.copy(picture)
    const file = Buffer.from(hwp(0, { '/BinData/BIN0001.jpg': picture }))
    const start = CFB.find(CFB.read(file, { type: 'buffer' }), '/BinData/BIN0001.jpg')!.start
    // The fixture fits in one FAT sector. Swap two physical sectors and adjust
    // the chain so the logical stream is identical but no longer contiguous.
    const fat = (file.readUInt32LE(76) + 1) * sectorSize
    const second = (start + 2) * sectorSize
    const third = second + sectorSize
    const temp = Buffer.from(file.subarray(second, third))
    file.copy(file, second, third, third + sectorSize)
    temp.copy(file, third)
    file.writeUInt32LE(start + 2, fat + start * 4)
    file.writeUInt32LE(start + 1, fat + (start + 2) * 4)
    file.writeUInt32LE(start + 3, fat + (start + 1) * 4)
    const path = await save('fragmented.hwp', file)
    const [image] = await listEmbeddedImages(path)
    expect(image!.hwpStream).toHaveProperty('stored')
    expect(sameBytes((await readEmbeddedImage(path, image!)).data, picture)).toBe(true)
  })

  it('keeps mini-stream data private between reads and refuses stale cached pictures', async () => {
    const path = await save('small.hwp', hwp(0, { '/BinData/BIN0001.jpg': JPEG }))
    const [image] = await listEmbeddedImages(path)
    expect(image!.hwpStream).toHaveProperty('stored')
    const first = await readEmbeddedImage(path, image!)
    first.data.fill(0)
    expect(sameBytes((await readEmbeddedImage(path, image!)).data, JPEG)).toBe(true)
    await writeFile(path, hwp(0, {}))
    await expect(readEmbeddedImage(path, image!)).rejects.toThrow(/changed/)
  })

  it('reads pictures of a document whose streams are not deflated', async () => {
    const path = await save('doc.hwp', hwp(0x0, { '/BinData/BIN0001.png': PNG }))
    const [image] = await listEmbeddedImages(path)
    const read = await readEmbeddedImage(path, image!)
    expect({ length: read.data.length, same: sameBytes(read.data, PNG) }).toEqual({
      length: PNG.length,
      same: true,
    })
  })

  it('lists nothing for a document without pictures', async () => {
    expect(await listEmbeddedImages(await save('doc.hwp', hwp(0x0, {})))).toEqual([])
  })

  it('refuses an encrypted document and says why', async () => {
    const path = await save('doc.hwp', hwp(0x2, { '/BinData/BIN0001.png': PNG }))
    await expect(listEmbeddedImages(path)).rejects.toThrow(/encrypted|password|protected/i)
  })
})
