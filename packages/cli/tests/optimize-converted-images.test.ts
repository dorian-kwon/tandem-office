import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32, deflateSync, inflateSync } from 'node:zlib'
import JSZip from 'jszip'
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { optimizeConvertedImages } from '../src/formats/optimize-converted-images'
import { tempDir, run } from './helpers'

function chunk(type: string, data: Buffer): Buffer {
  const part = Buffer.alloc(data.length + 12)
  part.writeUInt32BE(data.length)
  part.write(type, 4, 'ascii')
  data.copy(part, 8)
  part.writeUInt32BE(crc32(part.subarray(4, -4)), part.length - 4)
  return part
}
function png() {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(100)
  header.writeUInt32BE(80, 4)
  header[8] = 8
  header[9] = 6
  const raw = Buffer.alloc((100 * 4 + 1) * 80)
  for (let y = 0; y < 80; y++)
    for (let x = 0; x < 100; x++) raw.set([30, y * 3, x, 200], y * 401 + 1 + x * 4)
  const density = chunk('pHYs', Buffer.from([0, 0, 0x0e, 0xc4, 0, 0, 0x0e, 0xc4, 1]))
  const bytes = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    density,
    chunk('IDAT', deflateSync(raw, { level: 0 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
  return { raw, density, bytes }
}

describe('lossless image optimization on conversion outputs', () => {
  it.each(['docx', 'pptx', 'xlsx', 'hwpx', 'odt', 'ods', 'epub', 'xmind'])(
    'preserves image pixels, metadata and resource names in %s',
    async (ext) => {
      const file = join(tempDir(), 'document.' + ext)
      const { bytes, density, raw } = png()
      const archive = new JSZip()
      archive.file('mimetype', 'application/test')
      archive.file('body.xml', '<picture src="media/p.png"/>')
      archive.file('media/p.png', bytes)
      // A 512-by-512 RGB24 bitmap with a valid DIB header and aligned rows.
      const bmp = Buffer.alloc(54 + 512 * 512 * 3)
      bmp.write('BM')
      bmp.writeUInt32LE(bmp.length, 2)
      bmp.writeUInt32LE(54, 10)
      bmp.writeUInt32LE(40, 14)
      bmp.writeInt32LE(512, 18)
      bmp.writeInt32LE(512, 22)
      bmp.writeUInt16LE(1, 26)
      bmp.writeUInt16LE(24, 28)
      bmp.fill(192, 54)
      archive.file('media/raw.bmp', bmp)
      const original = await archive.generateAsync({ type: 'nodebuffer', compression: 'STORE' })
      writeFileSync(file, original)
      const info = await optimizeConvertedImages(file, ext)
      const smaller = readFileSync(file)
      expect(info).toEqual({ images: 2, bytesSaved: original.length - smaller.length })
      expect(smaller.length).toBeLessThan(original.length)
      expect(smaller.toString('ascii', 30, 38)).toBe('mimetype')
      expect(smaller.readUInt16LE(8)).toBe(0)
      const output = await JSZip.loadAsync(smaller, { checkCRC32: true })
      expect(await output.file('body.xml')!.async('string')).toBe('<picture src="media/p.png"/>')
      expect((await output.file('media/raw.bmp')!.async('nodebuffer')).equals(bmp)).toBe(true)
      const asset = await output.file('media/p.png')!.async('nodebuffer')
      expect(asset.includes(density)).toBe(true)
      const at = asset.indexOf('IDAT')
      expect(
        inflateSync(asset.subarray(at + 4, at + 4 + asset.readUInt32BE(at - 4))).equals(raw),
      ).toBe(true)
    },
  )

  it('recompresses only PDF image samples and retains dimensions, transparency references and decode settings', async () => {
    const path = join(tempDir(), 'image.pdf')
    const doc = await PDFDocument.create()
    const page = doc.addPage()
    const raw = Buffer.alloc(65536, 120)
    const mask = doc.context.register(
      doc.context.stream(Buffer.alloc(65536, 200), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 256,
        Height: 256,
        ColorSpace: 'DeviceGray',
        BitsPerComponent: 8,
      }),
    )
    const attrs = {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 256,
      Height: 256,
      ColorSpace: 'DeviceGray',
      BitsPerComponent: 8,
      SMask: mask,
      Decode: [1, 0],
      Filter: 'FlateDecode',
    }
    const ref = doc.context.register(doc.context.stream(deflateSync(raw, { level: 0 }), attrs))
    page.node.setXObject(PDFName.of('Picture'), ref)
    writeFileSync(path, await doc.save())
    const result = await optimizeConvertedImages(path, 'pdf')
    expect(result.images).toBe(2)
    expect(result.bytesSaved).toBeGreaterThan(100000)
    const output = await PDFDocument.load(readFileSync(path))
    const image = output.context.lookup(ref)
    const alpha = output.context.lookup(mask)
    if (!(image instanceof PDFRawStream) || !(alpha instanceof PDFRawStream)) {
      throw new Error('The original image and its transparency mask must remain streams')
    }
    expect(image.dict.get(PDFName.of('SMask'))?.toString()).toBe(mask.toString())
    expect(image.dict.get(PDFName.of('Decode'))?.toString()).toBe('[ 1 0 ]')
    expect(image.dict.get(PDFName.of('Width'))?.toString()).toBe('256')
    expect(inflateSync(image.contents).equals(raw)).toBe(true)
    expect(inflateSync(alpha.contents).equals(Buffer.alloc(65536, 200))).toBe(true)
  })
  it('keeps signed and metadata-only documents byte-identical', async () => {
    for (const type of ['text', 'signed', 'comment']) {
      const file = join(tempDir(), 'file.docx')
      const zip = new JSZip()
      zip.file('word/document.xml', 't'.repeat(8000))
      if (type !== 'text') zip.file('word/media/img.bmp', Buffer.alloc(64000, 27))
      if (type === 'signed') zip.file('_xmlsignatures/sig1.xml', 'sig')
      const bytes = await zip.generateAsync({
        type: 'nodebuffer',
        comment: type === 'comment' ? 'Authored comments' : undefined,
      })
      writeFileSync(file, bytes)
      expect(await optimizeConvertedImages(file, 'docx')).toEqual({ images: 0, bytesSaved: 0 })
      expect(readFileSync(file).equals(bytes)).toBe(true)
    }
  })
  it('uses the option on the actual HTML to HWPX conversion entry point', async () => {
    const dir = tempDir(),
      input = join(dir, 'input.html')
    const { bytes } = png()
    writeFileSync(
      input,
      '<p>Retained text</p><p><img src="data:image/png;base64,' +
        bytes.toString('base64') +
        '"></p>',
    )
    const baseline = await run([
      'convert',
      input,
      '--to',
      'hwpx',
      '--out',
      join(dir, 'first.hwpx'),
      '--json',
    ])
    expect(baseline.code, baseline.stdout).toBe(0)
    const optimized = await run(['convert', input, '--to', 'hwpx', '--optimize-images', '--json'])
    expect(optimized.code, optimized.stdout).toBe(0)
    const zip = await JSZip.loadAsync(readFileSync(join(dir, 'input.hwpx')))
    expect(await zip.file('Contents/section0.xml')!.async('string')).toContain('Retained text')
    expect(Object.keys(zip.files).some((name) => name.startsWith('BinData/'))).toBe(true)
    const saved =
      readFileSync(join(dir, 'first.hwpx')).length - readFileSync(join(dir, 'input.hwpx')).length
    expect(saved).toBeGreaterThan(0)
    expect(JSON.parse(optimized.stdout).detail.image_optimization).toEqual({
      images: 1,
      bytesSaved: saved,
    })
  })
})
