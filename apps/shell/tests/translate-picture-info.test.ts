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
  pictureFolderOf,
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

describe('pictureFolderOf', () => {
  it('knows the media folder of each zip-based format, and nothing else', () => {
    expect(pictureFolderOf('a.docx')).toBe('word/media/')
    expect(pictureFolderOf('a.PPTX')).toBe('ppt/media/')
    expect(pictureFolderOf('a.xlsx')).toBe('xl/media/')
    expect(pictureFolderOf('a.xlsm')).toBe('xl/media/')
    expect(pictureFolderOf('a.odt')).toBe('Pictures/')
    expect(pictureFolderOf('a.odp')).toBe('Pictures/')
    expect(pictureFolderOf('a.ods')).toBe('Pictures/')
    expect(pictureFolderOf('a.hwpx')).toBe('BinData/')
    expect(pictureFolderOf('a.epub')).toBe('')
    for (const other of ['a.pdf', 'a.png', 'a.md', 'a.txt', 'a.hwp', 'a.doc', 'a.xls', 'a'])
      expect(pictureFolderOf(other)).toBeNull()
  })
})

describe('countZipPictures', () => {
  it('counts pictures in word/media, skipping tiny ones and non-pictures', async () => {
    const bytes = await zipOf({
      'word/document.xml': '<w:document/>',
      'word/media/image1.png': noise(BIG),
      'word/media/image2.jpeg': noise(BIG),
      'word/media/bullet.png': noise(200),
      'word/media/clip.mp4': noise(BIG),
      'word/embeddings/x.png': noise(BIG),
    })
    expect(countZipPictures(bytes, 'word/media/')).toBe(2)
  })

  it('zero for a document without pictures', async () => {
    expect(countZipPictures(await zipOf({ 'word/document.xml': '<x/>' }), 'word/media/')).toBe(0)
  })

  it('an epub counts image items anywhere', async () => {
    const bytes = await zipOf({
      mimetype: 'application/epub+zip',
      'OEBPS/images/a.jpg': noise(BIG),
      'OEBPS/cover.png': noise(BIG),
      'OEBPS/text.xhtml': '<html/>',
    })
    expect(countZipPictures(bytes, '')).toBe(2)
  })

  it('unknown (null) for bytes that are not a zip', () => {
    expect(countZipPictures(new TextEncoder().encode('not a zip at all'), 'word/media/')).toBeNull()
    expect(countZipPictures(new Uint8Array(0), 'word/media/')).toBeNull()
  })

  it('unknown for an archive with more entries than the cap', async () => {
    const entries: Record<string, string> = {}
    for (let i = 0; i < 30; i += 1) entries[`word/media/i${i}.png`] = 'x'
    expect(countZipPictures(await zipOf(entries), 'word/media/', { maxEntries: 10 })).toBeNull()
  })

  it('unknown for a central directory that points past the file', async () => {
    const bytes = await zipOf({ 'word/media/a.png': noise(BIG) })
    // the end record's central-directory offset is its last-but-one field
    const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    bytes.writeUInt32LE(bytes.length + 100, eocd + 16)
    expect(countZipPictures(bytes, 'word/media/')).toBeNull()
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
    writeFileSync(join(dir, 'source', 'a.docx'), await zipOf({ 'word/media/p.png': noise(BIG) }))
    writeFileSync(join(dir, 'references', 'r.pptx'), await zipOf({ 'ppt/media/p.png': noise(BIG) }))
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
    writeFileSync(outside, await zipOf({ 'word/media/p.png': noise(BIG) }))
    symlinkSync(outside, join(dir, 'source', 'link.docx'))
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, 'r.docx'), await zipOf({ 'word/media/p.png': noise(BIG) }))
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
    writeFileSync(join(dir, 'source', 'a.docx'), await zipOf({ 'word/media/p.png': noise(BIG) }))
    const got = await createPictureInfo({ maxFileBytes: 100 }).forProject(dir, {
      sources: [{ file: 'a.docx', sha256: 'h', kind: 'editable' }],
      references: [],
    })
    expect(got[0]?.pictures).toBeNull()
  })

  it('keeps the answer per file and hash until the file changes', async () => {
    const dir = folders()
    const path = join(dir, 'source', 'a.docx')
    writeFileSync(path, await zipOf({ 'word/media/p.png': noise(BIG) }))
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
