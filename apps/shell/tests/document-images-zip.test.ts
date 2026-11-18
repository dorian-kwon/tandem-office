import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { bufferSource, readZipEntries, writeZip } from '@genoffice/docx-engine/zip-splice'
import { inspectZipBmp, optimizeZipBmp } from '../src/main/document-images/zip'

type Kind = 'docx' | 'xlsx' | 'pptx' | 'hwpx'
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
const BMP = Buffer.concat([Buffer.from('BM'), Buffer.alloc(1000, 47)])
const JPEG = Buffer.from([255, 216, 255, 224, 1, 2, 3, 255, 217])
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'
const rootOf = (kind: Kind) => ({ docx: 'word', xlsx: 'xl', pptx: 'ppt', hwpx: 'BinData' })[kind]
const imageOf = (kind: Kind) =>
  kind === 'hwpx' ? 'BinData/picture.bmp' : `${rootOf(kind)}/media/picture.bmp`
const bodyOf = (kind: Kind) =>
  ({
    docx: 'word/document.xml',
    xlsx: 'xl/workbook.xml',
    pptx: 'ppt/presentation.xml',
    hwpx: 'Contents/section0.xml',
  })[kind]
const refsOf = (kind: Kind) =>
  kind === 'hwpx'
    ? 'Contents/content.hpf'
    : `${rootOf(kind)}/_rels/${bodyOf(kind).split('/').pop()}.rels`
async function fixture(kind: Kind, change?: (zip: JSZip) => void) {
  const dir = await mkdtemp(join(tmpdir(), 'document-bmp-zip-'))
  dirs.push(dir)
  const input = join(dir, `original.${kind}`),
    output = join(dir, `copy.${kind}`),
    zip = new JSZip()
  zip.file(
    bodyOf(kind),
    '<document><text>Keep this text</text><drawing crop="0.25" rotation="90000" width="1212" height="3434" imageId="stableId"/></document>',
  )
  zip.file('custom/unknown.bin', Buffer.from([4, 5, 6, 7, 8, 9]), { compression: 'DEFLATE' })
  zip.file(imageOf(kind), BMP, { compression: 'DEFLATE' })
  if (kind === 'hwpx') {
    zip.file('mimetype', 'application/hwp+zip', { compression: 'STORE' })
    zip.file(
      refsOf(kind),
      '<opf:package xmlns:opf="http://www.idpf.org/2007/opf/"><opf:manifest><opf:item id="stableId" href="BinData/picture.bmp" media-type="image/bmp" isEmbeded="1"/></opf:manifest></opf:package>',
    )
  } else {
    zip.file(
      '[Content_Types].xml',
      `<Types xmlns="${CT}"><Default Extension="bmp" ContentType="image/bmp"/><Default Extension="xml" ContentType="application/xml"/></Types>`,
    )
    zip.file(
      refsOf(kind),
      `<Relationships xmlns="${REL}"><Relationship Id="stableId" Type="${IMAGE}" Target="media/picture.bmp"/><Relationship Id="external" Type="${IMAGE}" Target="https://example.invalid/picture.bmp" TargetMode="External"/></Relationships>`,
    )
  }
  change?.(zip)
  await writeFile(input, await zip.generateAsync({ type: 'nodebuffer' }))
  return { input, output, dir }
}
async function payloads(path: string) {
  const bytes = await readFile(path),
    entries = await readZipEntries(bufferSource(bytes))
  return new Map(entries.map((e) => [e.name, bytes.subarray(e.dataOffset, e.dataOffset + e.csize)]))
}
describe('ZIP embedded BMP copies', () => {
  it.each<Kind>(['docx', 'xlsx', 'pptx', 'hwpx'])(
    'preserves %s layout, IDs, original and unrelated compressed payloads',
    async (kind) => {
      const { input, output } = await fixture(kind),
        before = await readFile(input),
        rawBefore = await payloads(input)
      expect(await inspectZipBmp(input, kind)).toEqual({
        count: 1,
        bmpBytes: rawBefore.get(imageOf(kind))!.length,
      })
      const encode = vi.fn(async (bmp: Buffer) => {
          expect(bmp).toEqual(BMP)
          return JPEG
        }),
        progress = vi.fn()
      expect(await optimizeZipBmp(input, output, kind, encode, { onProgress: progress })).toEqual({
        converted: 1,
        skipped: 0,
      })
      expect(await readFile(input)).toEqual(before)
      const rawAfter = await payloads(output),
        zip = await JSZip.loadAsync(await readFile(output))
      expect(rawAfter.get(bodyOf(kind))).toEqual(rawBefore.get(bodyOf(kind)))
      expect(rawAfter.get('custom/unknown.bin')).toEqual(rawBefore.get('custom/unknown.bin'))
      expect(zip.file(imageOf(kind))).toBeNull()
      expect(await zip.file(imageOf(kind).replace('.bmp', '.jpg'))!.async('nodebuffer')).toEqual(
        JPEG,
      )
      const refs = await zip.file(refsOf(kind))!.async('string')
      expect(refs).toContain('stableId')
      expect(refs).toContain('picture.jpg')
      if (kind === 'hwpx') expect(refs).toContain('media-type="image/jpeg"')
      else {
        expect(refs).toContain('https://example.invalid/picture.bmp')
        expect(await zip.file('[Content_Types].xml')!.async('string')).toContain('image/jpeg')
      }
      expect(progress).toHaveBeenLastCalledWith(1, 1)
    },
  )
  it('avoids a preexisting JPEG name without changing that image', async () => {
    const existing = Buffer.from('untouched JPEG'),
      { input, output } = await fixture('docx', (zip) =>
        zip.file('word/media/picture.jpg', existing),
      )
    await optimizeZipBmp(input, output, 'docx', async () => JPEG)
    const zip = await JSZip.loadAsync(await readFile(output))
    expect(await zip.file('word/media/picture.jpg')!.async('nodebuffer')).toEqual(existing)
    const refs = await zip.file(refsOf('docx'))!.async('string')
    expect(refs).not.toContain('Target="media/picture.jpg"')
    expect(refs).toMatch(/Target="media\/picture[^"/]+\.jpg"/)
  })
  it('retains unsupported BMPs without changing metadata', async () => {
    const { input, output } = await fixture('docx')
    expect(await optimizeZipBmp(input, output, 'docx', async () => null)).toEqual({
      converted: 0,
      skipped: 1,
    })
    expect(await payloads(output)).toEqual(await payloads(input))
  })
  it.each(['_xmlsignatures/sig1.xml', 'META-INF/signatures.xml', 'META-INF/encryption.xml'])(
    'refuses signed/encrypted containers (%s)',
    async (path) => {
      const { input, output } = await fixture('docx', (zip) => zip.file(path, '<signed/>'))
      expect(await inspectZipBmp(input, 'docx')).toBeNull()
      await expect(optimizeZipBmp(input, output, 'docx', async () => JPEG)).rejects.toThrow()
      await expect(readFile(output)).rejects.toThrow()
    },
  )
  it('refuses duplicate archive names', async () => {
    const { input } = await fixture('docx'),
      bytes = await readFile(input),
      entries = await readZipEntries(bufferSource(bytes)),
      first = entries.find((e) => e.name === imageOf('docx'))!
    await writeFile(
      input,
      writeZip(
        [...entries, first].map((e) => ({
          meta: e,
          data: bytes.subarray(e.dataOffset, e.dataOffset + e.csize),
        })),
      ),
    )
    expect(await inspectZipBmp(input, 'docx')).toBeNull()
  })
  it('refuses ambiguous content types and unsafe names', async () => {
    const duplicate = await fixture('xlsx', (zip) =>
      zip.file(
        '[Content_Types].xml',
        `<Types xmlns="${CT}"><Default Extension="bmp" ContentType="image/bmp"/><Default Extension="BMP" ContentType="image/png"/></Types>`,
      ),
    )
    expect(await inspectZipBmp(duplicate.input, 'xlsx')).toBeNull()
    const traversal = await fixture('pptx', (zip) => zip.file('../escape.bmp', BMP))
    expect(await inspectZipBmp(traversal.input, 'pptx')).toBeNull()
  })
  it('never overwrites an existing destination or input', async () => {
    const { input, output } = await fixture('docx'),
      original = await readFile(input)
    await writeFile(output, 'existing destination')
    await expect(optimizeZipBmp(input, output, 'docx', async () => JPEG)).rejects.toThrow()
    await expect(optimizeZipBmp(input, input, 'docx', async () => JPEG)).rejects.toThrow()
    expect(await readFile(input)).toEqual(original)
    expect(await readFile(output, 'utf8')).toBe('existing destination')
  })
  it('cancels without altering the source or retaining output', async () => {
    const { input, output } = await fixture('hwpx'),
      original = await readFile(input),
      abort = new AbortController()
    await expect(
      optimizeZipBmp(
        input,
        output,
        'hwpx',
        async () => {
          abort.abort()
          return JPEG
        },
        { signal: abort.signal },
      ),
    ).rejects.toThrow()
    expect(await readFile(input)).toEqual(original)
    await expect(readFile(output)).rejects.toThrow()
  })
  it('updates explicit content-type overrides and encoded absolute relationships', async () => {
    const { input, output } = await fixture('pptx', (zip) => {
      zip.remove(imageOf('pptx'))
      zip.file('ppt/media/my picture.bmp', BMP)
      zip.file(
        '[Content_Types].xml',
        `<Types xmlns="${CT}"><Override PartName="/ppt/media/my%20picture.bmp" ContentType="image/bmp"/></Types>`,
      )
      zip.file(
        refsOf('pptx'),
        `<Relationships xmlns="${REL}"><Relationship Id="stableId" Type="${IMAGE}" Target="/ppt/media/my%20picture.bmp"/></Relationships>`,
      )
    })
    await optimizeZipBmp(input, output, 'pptx', async () => JPEG)
    const zip = await JSZip.loadAsync(await readFile(output))
    expect(await zip.file(refsOf('pptx'))!.async('string')).toContain('/ppt/media/my%20picture.jpg')
    const types = await zip.file('[Content_Types].xml')!.async('string')
    expect(types).toContain('/ppt/media/my%20picture.jpg')
    expect(types).toContain('image/jpeg')
  })
})

describe('ZIP conversion boundaries', () => {
  it('accepts HWPX manifest-relative hrefs and leaves the item ID unchanged', async () => {
    const { input, output } = await fixture('hwpx', (zip) =>
      zip.file(
        refsOf('hwpx'),
        '<opf:package xmlns:opf="http://www.idpf.org/2007/opf"><opf:manifest><opf:item id="stableId" href="../BinData/picture.bmp" media-type="image/bmp"/></opf:manifest></opf:package>',
      ),
    )
    expect(await inspectZipBmp(input, 'hwpx')).toEqual({
      count: 1,
      bmpBytes: (await payloads(input)).get(imageOf('hwpx'))!.length,
    })
    await optimizeZipBmp(input, output, 'hwpx', async () => JPEG)
    const zip = await JSZip.loadAsync(await readFile(output))
    expect(await zip.file(refsOf('hwpx'))!.async('string')).toContain(
      'id="stableId" href="../BinData/picture.jpg"',
    )
  })

  it('rejects HWPX hrefs resolving to two different existing parts', async () => {
    const { input } = await fixture('hwpx', (zip) => zip.file('Contents/BinData/picture.bmp', BMP))
    expect(await inspectZipBmp(input, 'hwpx')).toBeNull()
  })

  it('converts a shared image once and updates every relationship', async () => {
    const { input, output } = await fixture('docx', (zip) =>
      zip.file(
        'word/_rels/header1.xml.rels',
        `<Relationships xmlns="${REL}"><Relationship Id="headerPicture" Type="${IMAGE}" Target="media/picture.bmp"/></Relationships>`,
      ),
    )
    const encode = vi.fn(async () => JPEG)
    expect(await optimizeZipBmp(input, output, 'docx', encode)).toEqual({
      converted: 1,
      skipped: 0,
    })
    expect(encode).toHaveBeenCalledTimes(1)
    const zip = await JSZip.loadAsync(await readFile(output))
    expect(await zip.file('word/_rels/header1.xml.rels')!.async('string')).toContain(
      'Id="headerPicture"',
    )
    expect(await zip.file('word/_rels/header1.xml.rels')!.async('string')).toContain(
      'media/picture.jpg',
    )
  })

  it('does not adopt a non-image relationship to an image part', async () => {
    const { input } = await fixture('docx', (zip) =>
      zip.file(
        '_rels/.rels',
        `<Relationships xmlns="${REL}"><Relationship Id="notImage" Type="urn:custom" Target="word/media/picture.bmp"/></Relationships>`,
      ),
    )
    expect(await inspectZipBmp(input, 'docx')).toBeNull()
  })

  it('detects signature relationship types even without a signature part', async () => {
    const { input } = await fixture('docx', (zip) =>
      zip.file(
        '_rels/.rels',
        `<Relationships xmlns="${REL}"><Relationship Id="signature" Type="http://schemas.openxmlformats.org/package/2006/relationships/digital-signature/origin" Target="custom.xml"/></Relationships>`,
      ),
    )
    expect(await inspectZipBmp(input, 'docx')).toBeNull()
  })

  it.each([
    '<!DOCTYPE Types [<!ENTITY image "image/bmp">]>',
    '<?xml version="1.0" encoding="utf-16"?>',
  ])('rejects unsupported XML metadata (%s)', async (prefix) => {
    const { input } = await fixture('xlsx', (zip) =>
      zip.file(
        '[Content_Types].xml',
        `${prefix}<Types xmlns="${CT}"><Default Extension="bmp" ContentType="image/bmp"/></Types>`,
      ),
    )
    expect(await inspectZipBmp(input, 'xlsx')).toBeNull()
  })

  it('rejects corrupted compressed BMP payloads and cleans temporary files', async () => {
    const { input, output, dir } = await fixture('docx'),
      bytes = await readFile(input),
      entries = await readZipEntries(bufferSource(bytes)),
      bmp = entries.find((e) => e.name === imageOf('docx'))!
    bytes[bmp.dataOffset] = bytes[bmp.dataOffset]! ^ 255
    await writeFile(input, bytes)
    await expect(optimizeZipBmp(input, output, 'docx', async () => JPEG)).rejects.toThrow()
    expect(await readdir(dir)).toEqual(['original.docx'])
  })

  it('checks source identity again after the asynchronous encoder returns', async () => {
    const { input, output, dir } = await fixture('docx')
    await expect(
      optimizeZipBmp(input, output, 'docx', async () => {
        await appendFile(input, 'changed')
        return JPEG
      }),
    ).rejects.toThrow('Source document changed')
    expect(await readdir(dir)).toEqual(['original.docx'])
  })

  it('does not allocate or decode a BMP whose declared size exceeds 192 MiB', async () => {
    const { input, output } = await fixture('docx'),
      bytes = await readFile(input),
      entries = await readZipEntries(bufferSource(bytes))
    await writeFile(
      input,
      writeZip(
        entries.map((e) => ({
          meta: e.name === imageOf('docx') ? { ...e, usize: 193 * 1024 * 1024 } : e,
          data: bytes.subarray(e.dataOffset, e.dataOffset + e.csize),
        })),
      ),
    )
    const encode = vi.fn(async () => JPEG)
    expect(await optimizeZipBmp(input, output, 'docx', encode)).toEqual({
      converted: 0,
      skipped: 1,
    })
    expect(encode).not.toHaveBeenCalled()
    expect(await payloads(output)).toEqual(await payloads(input))
  })

  it('keeps a JPEG replacement that would enlarge the stored image out of the copy', async () => {
    const { input, output } = await fixture('pptx')
    const bigger = Buffer.concat([JPEG, Buffer.alloc(BMP.length)])
    expect(await optimizeZipBmp(input, output, 'pptx', async () => bigger)).toEqual({
      converted: 0,
      skipped: 1,
    })
    expect(await payloads(output)).toEqual(await payloads(input))
  })

  it('preserves an unsupported second BMP while converting the first sequentially', async () => {
    const { input, output } = await fixture('xlsx', (zip) => {
      zip.file('xl/media/second.bmp', Buffer.concat([Buffer.from('BM'), Buffer.alloc(1000, 48)]))
      zip.file(
        refsOf('xlsx'),
        `<Relationships xmlns="${REL}"><Relationship Id="one" Type="${IMAGE}" Target="media/picture.bmp"/><Relationship Id="two" Type="${IMAGE}" Target="media/second.bmp"/></Relationships>`,
      )
    })
    let running = false,
      calls = 0
    const result = await optimizeZipBmp(input, output, 'xlsx', async () => {
      expect(running).toBe(false)
      running = true
      await new Promise((resolve) => setTimeout(resolve, 1))
      running = false
      return ++calls === 1 ? JPEG : null
    })
    expect(result).toEqual({ converted: 1, skipped: 1 })
    const zip = await JSZip.loadAsync(await readFile(output)),
      refs = await zip.file(refsOf('xlsx'))!.async('string')
    expect(refs).toContain('media/picture.jpg')
    expect(refs).toContain('media/second.bmp')
    expect((await payloads(output)).get('xl/media/second.bmp')).toEqual(
      (await payloads(input)).get('xl/media/second.bmp'),
    )
  })
})

describe('ZIP review regressions', () => {
  const ODF = 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0'

  it('updates optional HWPX package-manifest paths and media types without touching other entries', async () => {
    const metadata = `<m:manifest xmlns:m="${ODF}"><m:file-entry m:full-path="/" m:media-type="application/hwp+zip"/><m:file-entry m:full-path="BinData/picture.bmp" m:media-type="image/bmp"/><m:file-entry m:full-path="Contents/section0.xml" m:media-type="application/xml"/></m:manifest>`
    const { input, output } = await fixture('hwpx', (zip) =>
      zip.file('META-INF/manifest.xml', metadata),
    )
    await optimizeZipBmp(input, output, 'hwpx', async () => JPEG)
    const zip = await JSZip.loadAsync(await readFile(output))
    expect(await zip.file('META-INF/manifest.xml')!.async('string')).toBe(
      metadata.replace('picture.bmp', 'picture.jpg').replace('image/bmp', 'image/jpeg'),
    )
    expect(await zip.file(refsOf('hwpx'))!.async('string')).toContain('href="BinData/picture.jpg"')
  })

  it.each(['image/png', 'application/octet-stream'])(
    'rejects a conflicting HWPX OPF alias (%s) of an embedded BMP',
    async (mime) => {
      const { input, output } = await fixture('hwpx', (zip) =>
        zip.file(
          refsOf('hwpx'),
          `<opf:package xmlns:opf="http://www.idpf.org/2007/opf/"><opf:manifest><opf:item id="alias" href="BinData/picture.bmp" media-type="${mime}"/><opf:item id="stableId" href="BinData/picture.bmp" media-type="image/bmp"/></opf:manifest></opf:package>`,
        ),
      )
      expect(await inspectZipBmp(input, 'hwpx')).toBeNull()
      await expect(optimizeZipBmp(input, output, 'hwpx', async () => JPEG)).rejects.toThrow()
      await expect(readFile(output)).rejects.toThrow()
    },
  )

  it.each([14, 18, 22])(
    'rejects local ZIP CRC/size disagreement at header offset %i',
    async (offset) => {
      const { input, output } = await fixture('docx'),
        bytes = await readFile(input),
        entries = await readZipEntries(bufferSource(bytes)),
        image = entries.find((e) => e.name === imageOf('docx'))!
      const local = image.dataOffset - 30 - image.nameBytes.length
      expect(bytes.readUInt32LE(local)).toBe(0x04034b50)
      expect(bytes.readUInt16LE(local + 6) & 8).toBe(0)
      bytes.writeUInt32LE((bytes.readUInt32LE(local + offset) + 1) >>> 0, local + offset)
      await writeFile(input, bytes)
      expect(await inspectZipBmp(input, 'docx')).toBeNull()
      await expect(optimizeZipBmp(input, output, 'docx', async () => JPEG)).rejects.toThrow()
    },
  )

  it('allows an unrelated self-closing empty Relationships root and preserves its raw payload', async () => {
    const empty = 'word/_rels/styles.xml.rels'
    const { input, output } = await fixture('docx', (zip) =>
      zip.file(empty, `<r:Relationships xmlns:r="${REL}" />`, { compression: 'DEFLATE' }),
    )
    expect(await inspectZipBmp(input, 'docx')).toEqual({
      count: 1,
      bmpBytes: (await payloads(input)).get(imageOf('docx'))!.length,
    })
    await optimizeZipBmp(input, output, 'docx', async () => JPEG)
    expect((await payloads(output)).get(empty)).toEqual((await payloads(input)).get(empty))
  })

  it.each([true, false])(
    'reserves directories (explicit=%s) and stale content-type overrides when choosing a JPEG name',
    async (explicit) => {
      const { input, output } = await fixture('docx', (zip) => {
        if (explicit) zip.folder('word/media/picture.jpg')
        zip.file('word/media/picture.jpg/notes.txt', 'directory contents', { createFolders: false })
        zip.file(
          '[Content_Types].xml',
          `<Types xmlns="${CT}"><Default Extension="bmp" ContentType="image/bmp"/><Override PartName="/word/media/PICTURE.optimized-2.JPG" ContentType="image/png"/></Types>`,
        )
      })
      await optimizeZipBmp(input, output, 'docx', async () => JPEG)
      const zip = await JSZip.loadAsync(await readFile(output))
      expect(zip.file('word/media/picture.jpg')).toBeNull()
      expect(await zip.file('word/media/picture.optimized-3.jpg')!.async('nodebuffer')).toEqual(
        JPEG,
      )
      expect(await zip.file('word/media/picture.jpg/notes.txt')!.async('string')).toBe(
        'directory contents',
      )
      const types = await zip.file('[Content_Types].xml')!.async('string')
      expect(types).toContain(
        'PartName="/word/media/PICTURE.optimized-2.JPG" ContentType="image/png"',
      )
      expect(types).toContain(
        'PartName="/word/media/picture.optimized-3.jpg" ContentType="image/jpeg"',
      )
    },
  )
})

describe('ZIP metadata compatibility after review fixes', () => {
  it('updates both valid OPF aliases while preserving their IDs', async () => {
    const manifest =
      '<opf:package xmlns:opf="http://www.idpf.org/2007/opf/"><opf:manifest><opf:item id="one" href="BinData/picture.bmp" media-type="image/bmp"/><opf:item id="two" href="../BinData/picture.bmp" media-type="image/bmp"/></opf:manifest></opf:package>'
    const { input, output } = await fixture('hwpx', (zip) => zip.file(refsOf('hwpx'), manifest))
    const encode = vi.fn(async () => JPEG)
    expect(await optimizeZipBmp(input, output, 'hwpx', encode)).toEqual({
      converted: 1,
      skipped: 0,
    })
    expect(encode).toHaveBeenCalledTimes(1)
    const zip = await JSZip.loadAsync(await readFile(output))
    expect(await zip.file(refsOf('hwpx'))!.async('string')).toBe(
      manifest.replaceAll('picture.bmp', 'picture.jpg').replaceAll('image/bmp', 'image/jpeg'),
    )
  })

  it('accepts valid data-descriptor ZIP entries whose local sizes are placeholders', async () => {
    const { input, output } = await fixture('pptx')
    const original = await JSZip.loadAsync(await readFile(input))
    await writeFile(
      input,
      await original.generateAsync({
        type: 'nodebuffer',
        streamFiles: true,
        compression: 'DEFLATE',
      }),
    )
    const before = await payloads(input)
    const entries = await readZipEntries(bufferSource(await readFile(input)))
    expect(entries.find((e) => e.name === imageOf('pptx'))!.flags & 8).toBe(8)
    expect(await inspectZipBmp(input, 'pptx')).toEqual({
      count: 1,
      bmpBytes: (await payloads(input)).get(imageOf('pptx'))!.length,
    })
    expect(await optimizeZipBmp(input, output, 'pptx', async () => JPEG)).toEqual({
      converted: 1,
      skipped: 0,
    })
    const after = await payloads(output)
    expect(after.get(bodyOf('pptx'))).toEqual(before.get(bodyOf('pptx')))
  })
})
