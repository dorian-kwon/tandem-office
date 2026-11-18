import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import * as CFB from 'cfb'
import init, { HwpDocument } from '@rhwp/core'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { inspectHwpBmp, optimizeHwpBmp } from '../src/main/embedded-bmp'
import { openHwp, recordsOf, streamOf, writeContainer } from '../src/main/hwp5-file'

function record(tag: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(4)
  header.writeUInt32LE(tag | (payload.length << 20))
  return Buffer.concat([header, payload])
}
function bin(id: number, attr: number, extension = 'bmp'): Buffer {
  const data = Buffer.alloc(6 + extension.length * 2)
  data.writeUInt16LE(attr)
  data.writeUInt16LE(id, 2)
  data.writeUInt16LE(extension.length, 4)
  data.write(extension, 6, 'utf16le')
  return record(18, data)
}
function bmp(seed = 0): Buffer {
  const data = Buffer.alloc(128, seed)
  for (let i = 6; i < data.length; i++) data[i] = (i * 37 + seed * 41) % 256
  data.write('BM')
  data.writeUInt32LE(data.length, 2)
  return data
}
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9])

function fixture(compressed = true, extraFlags = 0) {
  const cfb = CFB.utils.cfb_new()
  const header = Buffer.alloc(256)
  header.write('HWP Document File')
  header[35] = 5
  header.writeUInt32LE(Number(compressed) | extraFlags, 36)
  const info = Buffer.concat([
    record(16, Buffer.from('preserved document properties')),
    bin(7, 0x101),
    bin(9, 0x121),
    bin(12, 0x111),
    bin(15, 0x101, 'png'),
  ])
  CFB.utils.cfb_add(cfb, '/FileHeader', header)
  CFB.utils.cfb_add(cfb, '/DocInfo', compressed ? deflateRawSync(info) : info)
  CFB.utils.cfb_add(cfb, '/BinData/BIN0007.bmp', compressed ? deflateRawSync(bmp(1)) : bmp(1))
  CFB.utils.cfb_add(cfb, '/BinData/BIN0009.bmp', bmp(2))
  CFB.utils.cfb_add(cfb, '/BinData/BIN000C.bmp', deflateRawSync(bmp(3)))
  CFB.utils.cfb_add(cfb, '/BinData/BIN000F.png', Buffer.from('untouched image'))
  CFB.utils.cfb_add(cfb, '/BodyText/Section0', Buffer.from('raw section with memo/field/crop refs'))
  CFB.utils.cfb_add(cfb, '/Scripts/DefaultJScript', Buffer.from('unknown script payload'))
  CFB.utils.cfb_add(cfb, '/PrvText', Buffer.from('preview text'))
  return writeContainer(cfb)
}
function raw(bytes: Uint8Array): Map<string, Buffer> {
  const cfb = CFB.read(Buffer.from(bytes), { type: 'buffer' })
  return new Map(
    cfb.FullPaths.flatMap((path, i) =>
      cfb.FileIndex[i].type === 2
        ? [
            [
              path.slice(cfb.FullPaths[0].length),
              Buffer.from(cfb.FileIndex[i].content as Uint8Array),
            ] as const,
          ]
        : [],
    ),
  )
}

describe('HWP embedded BMP copies', () => {
  it.each([true, false])(
    'counts on-disk BMP bytes with compression overrides (header=%s)',
    (compressed) => {
      const source = fixture(compressed)
      const total = [...raw(source)].reduce(
        (sum, [path, bytes]) => sum + (path.endsWith('.bmp') ? bytes.length : 0),
        0,
      )
      expect(inspectHwpBmp(source)).toEqual({ count: 3, bmpBytes: total })
    },
  )

  it.each([true, false])(
    'only changes image streams and same-length extensions (header=%s)',
    async (compressed) => {
      const source = fixture(compressed)
      const original = Buffer.from(source)
      const progress = vi.fn()
      const encode = vi.fn(async () => jpeg)
      const result = await optimizeHwpBmp(source, encode, { onProgress: progress })
      expect(result.converted).toBe(3)
      expect(result.skipped).toBe(0)
      expect(source.equals(original)).toBe(true)
      expect(encode.mock.calls).toHaveLength(3)
      expect(progress.mock.calls).toEqual([
        [1, 3],
        [2, 3],
        [3, 3],
      ])
      const before = raw(source),
        after = raw(result.bytes)
      for (const [name, bytes] of before) {
        if (name === 'DocInfo' || name.endsWith('.bmp')) continue
        expect(after.get(name), name).toEqual(bytes)
      }
      for (const [name, isCompressed] of [
        ['BIN0007', compressed],
        ['BIN0009', false],
        ['BIN000C', true],
      ] as const) {
        expect(after.has(`BinData/${name}.bmp`)).toBe(false)
        const bytes = after.get(`BinData/${name}.jpg`)!
        expect(isCompressed ? inflateRawSync(bytes) : bytes).toEqual(jpeg)
      }
      const infoBefore = streamOf(openHwp(source)!, '/DocInfo')!
      const expected = Buffer.from(infoBefore)
      for (const rec of recordsOf(infoBefore)!) {
        if (rec.tag === 18 && infoBefore.toString('utf16le', rec.body + 6, rec.end) === 'bmp') {
          expected.write('jpg', rec.body + 6, 'utf16le')
        }
      }
      expect(streamOf(openHwp(result.bytes)!, '/DocInfo')).toEqual(expected)
      expect(inspectHwpBmp(result.bytes)).toEqual({ count: 0, bmpBytes: 0 })
    },
  )

  it('leaves skipped assets and returns the exact original if none converts', async () => {
    const source = fixture()
    const result = await optimizeHwpBmp(source, async () => null)
    expect(result.bytes.equals(source)).toBe(true)
    expect(result.converted).toBe(0)
    expect(result.skipped).toBe(3)
    let n = 0
    const partial = await optimizeHwpBmp(source, async () => (++n === 2 ? jpeg : null))
    expect(partial.converted).toBe(1)
    expect(partial.skipped).toBe(2)
    const before = raw(source),
      after = raw(partial.bytes)
    expect(after.get('BinData/BIN0007.bmp')).toEqual(before.get('BinData/BIN0007.bmp'))
    expect(after.get('BinData/BIN000C.bmp')).toEqual(before.get('BinData/BIN000C.bmp'))
  })

  it.each([2, 4, 16, 128, 256, 512, 1024])(
    'rejects protected/signed header flags %s',
    async (flag) => {
      const source = fixture(true, flag)
      expect(inspectHwpBmp(source)).toBeNull()
      const encode = vi.fn()
      await expect(optimizeHwpBmp(source, encode)).rejects.toThrow()
      expect(encode).not.toHaveBeenCalled()
    },
  )

  it.each([
    'collision',
    'directory-collision',
    'duplicate-id',
    'missing',
    'signature',
    'bad-deflate',
    'orphan',
  ])('rejects %s before encoding', async (kind) => {
    const cfb = openHwp(fixture())!.cfb
    if (kind === 'collision') CFB.utils.cfb_add(cfb, '/BinData/BIN0007.jpg', jpeg)
    if (kind === 'directory-collision') CFB.utils.cfb_add(cfb, '/BinData/BIN0007.jpg/child', jpeg)
    if (kind === 'signature')
      CFB.utils.cfb_add(cfb, '/DocOptions/_SignDigit', Buffer.from('signed'))
    if (kind === 'missing') CFB.utils.cfb_del(cfb, '/BinData/BIN0007.bmp')
    if (kind === 'orphan') CFB.utils.cfb_add(cfb, '/BinData/BIN0033.bmp', bmp())
    if (kind === 'bad-deflate')
      CFB.utils.cfb_add(cfb, '/BinData/BIN0007.bmp', Buffer.from('not compressed'))
    if (kind === 'duplicate-id') {
      const info = inflateRawSync(Buffer.from(CFB.find(cfb, '/DocInfo')!.content as Uint8Array))
      CFB.utils.cfb_add(cfb, '/DocInfo', deflateRawSync(Buffer.concat([info, bin(7, 0x101)])))
    }
    const source = writeContainer(cfb)
    expect(inspectHwpBmp(source)).toBeNull()
    const encode = vi.fn()
    await expect(optimizeHwpBmp(source, encode)).rejects.toThrow()
    expect(encode).not.toHaveBeenCalled()
  })

  it('aborts between sequential encodes without mutating the source', async () => {
    const source = fixture(),
      before = Buffer.from(source)
    const abort = new AbortController()
    const encode = vi.fn(async () => {
      abort.abort()
      return jpeg
    })
    await expect(optimizeHwpBmp(source, encode, { signal: abort.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(encode).toHaveBeenCalledTimes(1)
    expect(source.equals(before)).toBe(true)
  })

  it('fails closed on malformed input and propagates encoder failures', async () => {
    expect(inspectHwpBmp(Buffer.from('not a document'))).toBeNull()
    const source = fixture(),
      before = Buffer.from(source)
    await expect(
      optimizeHwpBmp(source, async () => {
        throw new Error('codec failed')
      }),
    ).rejects.toThrow('codec failed')
    expect(source.equals(before)).toBe(true)
  })

  it('rejects invalid encoder output and skips a larger replacement', async () => {
    await expect(optimizeHwpBmp(fixture(), async () => Buffer.from('bad'))).rejects.toThrow()
    const source = fixture()
    const result = await optimizeHwpBmp(source, async () => Buffer.alloc(200))
    expect(result.bytes.equals(source)).toBe(true)
    expect(result.skipped).toBe(3)
  })

  it('skips JPEGs larger than the existing compressed BMP stream', async () => {
    const cfb = openHwp(fixture())!.cfb
    const uniform = Buffer.alloc(128)
    uniform.write('BM')
    CFB.utils.cfb_add(cfb, '/BinData/BIN0007.bmp', deflateRawSync(uniform))
    const source = writeContainer(cfb)
    const result = await optimizeHwpBmp(source, async () => jpeg)
    expect(result.converted).toBe(2)
    expect(result.skipped).toBe(1)
    expect(raw(result.bytes).get('BinData/BIN0007.bmp')).toEqual(
      raw(source).get('BinData/BIN0007.bmp'),
    )
  })

  it('keeps the exact source bytes when there are no BMP records', async () => {
    const source = (await optimizeHwpBmp(fixture(), async () => jpeg)).bytes
    const encode = vi.fn()
    expect(inspectHwpBmp(source)).toEqual({ count: 0, bmpBytes: 0 })
    expect((await optimizeHwpBmp(source, encode)).bytes.equals(source)).toBe(true)
    expect(encode).not.toHaveBeenCalled()
  })

  it('does not inspect or invoke the encoder after an existing cancellation', async () => {
    const abort = new AbortController()
    abort.abort()
    const encode = vi.fn()
    await expect(optimizeHwpBmp(fixture(), encode, { signal: abort.signal })).rejects.toMatchObject(
      { name: 'AbortError' },
    )
    expect(encode).not.toHaveBeenCalled()
  })
})

// A generated 2x2 red JPEG; the adapter's codec is injected, with no native process or AI.
const realJpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD50ooor8MP9Uz/2Q==',
  'base64',
)

describe('real engine opens the optimized copy', () => {
  beforeAll(async () => {
    const require = createRequire(import.meta.url)
    await init({
      module_or_path: readFileSync(join(dirname(require.resolve('@rhwp/core')), 'rhwp_bg.wasm')),
    })
  })

  it('preserves text, pages and memos with byte-identical body streams', async () => {
    const image = Buffer.alloc(2048)
    let seed = 17
    for (let i = 70; i < image.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      image[i] = seed >>> 24
    }
    image.write('BM')
    image.writeUInt32LE(image.length, 2)
    image.writeUInt32LE(54, 10)
    image.writeUInt32LE(40, 14)
    image.writeInt32LE(2, 18)
    image.writeInt32LE(2, 22)
    image.writeUInt16LE(1, 26)
    image.writeUInt16LE(24, 28)
    image.writeUInt32LE(16, 34)
    for (const offset of [54, 57, 62, 65]) image[offset + 2] = 255
    const doc = new HwpDocument(readFileSync(join(__dirname, 'fixtures', 'memo-source.hwp')))
    let before: HwpDocument | undefined, after: HwpDocument | undefined
    try {
      doc.insertPicture(0, 0, 0, '[]', image, 3000, 3000, 2, 2, 'bmp', 'fixture')
      const source = Buffer.from(doc.exportHwp())
      expect(inspectHwpBmp(source)!.count).toBeGreaterThan(0)
      const optimized = await optimizeHwpBmp(source, async (data) =>
        data.equals(image) ? realJpeg : null,
      )
      expect(optimized.converted).toBe(1)
      before = new HwpDocument(source)
      after = new HwpDocument(optimized.bytes)
      expect(after.getTextFileText()).toBe(before.getTextFileText())
      expect(after.pageCount()).toBe(before.pageCount())
      expect(after.getMemoList()).toBe(before.getMemoList())
      const originalStreams = raw(source),
        copiedStreams = raw(optimized.bytes)
      for (const [name, bytes] of originalStreams) {
        if (name.startsWith('BodyText/')) expect(copiedStreams.get(name)).toEqual(bytes)
      }
    } finally {
      doc.free()
      before?.free()
      after?.free()
    }
  })
})
