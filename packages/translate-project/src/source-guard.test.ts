import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  UnsupportedSourceError,
  classifySource,
  copyIntoWithSuffix,
  importSource,
  verifySource,
} from './source-guard'

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

let root: string
let projectDir: string
let originals: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'source-guard-'))
  projectDir = join(root, 'project')
  originals = join(root, 'originals')
  await mkdir(projectDir, { recursive: true })
  await mkdir(originals, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const makeOriginal = async (name: string, content = 'hello'): Promise<string> => {
  const p = join(originals, name)
  await writeFile(p, content)
  return p
}

describe('importSource', () => {
  it('copies file into source/ and records sha256', async () => {
    const p = await makeOriginal('doc.docx', 'abc')
    const entry = await importSource(projectDir, p)
    expect(entry).toEqual({ file: 'doc.docx', sha256: sha('abc'), kind: 'editable' })
    expect(await readFile(join(projectDir, 'source', 'doc.docx'), 'utf8')).toBe('abc')
  })

  it('second import of same name gets suffix (2)', async () => {
    const p = await makeOriginal('doc.docx', 'abc')
    await importSource(projectDir, p)
    const second = await importSource(projectDir, p)
    expect(second.file).toBe('doc (2).docx')
    expect(await readdir(join(projectDir, 'source'))).toEqual(['doc (2).docx', 'doc.docx'])
  })

  it('import never modifies the original file', async () => {
    const p = await makeOriginal('doc.pdf', 'pdf-bytes')
    const past = new Date('2020-01-01T00:00:00Z')
    await utimes(p, past, past)
    const before = await stat(p)
    const entry = await importSource(projectDir, p)
    const after = await stat(p)
    expect(entry.kind).toBe('pdf')
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(sha(await readFile(p))).toBe(sha('pdf-bytes'))
  })

  it('rejects unsupported extensions without copying', async () => {
    const p = await makeOriginal('a.exe')
    await expect(importSource(projectDir, p)).rejects.toBeInstanceOf(UnsupportedSourceError)
    await expect(readdir(join(projectDir, 'source'))).rejects.toThrow()
  })
})

describe('verifySource', () => {
  it('returns ok for an untouched copy', async () => {
    const entry = await importSource(projectDir, await makeOriginal('a.md'))
    expect(await verifySource(projectDir, entry)).toBe('ok')
  })

  it('returns changed after the copy is modified', async () => {
    const entry = await importSource(projectDir, await makeOriginal('a.md'))
    await writeFile(join(projectDir, 'source', 'a.md'), 'edited')
    expect(await verifySource(projectDir, entry)).toBe('changed')
  })

  it('returns missing after deletion', async () => {
    const entry = await importSource(projectDir, await makeOriginal('a.md'))
    await rm(join(projectDir, 'source', 'a.md'))
    expect(await verifySource(projectDir, entry)).toBe('missing')
  })
})

describe('classifySource', () => {
  it('classifies editable, pdf and image extensions case-insensitively', () => {
    for (const n of [
      'a.docx',
      'a.XLSX',
      'a.pptx',
      'a.hwp',
      'a.hwpx',
      'a.epub',
      'a.md',
      'a.HTML',
      'a.txt',
      'a.odt',
    ])
      expect(classifySource(n)).toBe('editable')
    expect(classifySource('a.PDF')).toBe('pdf')
    for (const n of ['a.png', 'a.JPG', 'a.jpeg', 'a.gif', 'a.bmp', 'a.tif', 'a.tiff', 'a.webp'])
      expect(classifySource(n)).toBe('image')
  })

  it('throws UnsupportedSourceError for unknown or missing extensions', () => {
    expect(() => classifySource('a.exe')).toThrow(UnsupportedSourceError)
    expect(() => classifySource('noext')).toThrow(UnsupportedSourceError)
  })
})

describe('copyIntoWithSuffix', () => {
  it('creates the directory and numbers collisions without overwriting', async () => {
    const p = await makeOriginal('ref.txt', 'one')
    const dest = join(root, 'refs')
    expect(await copyIntoWithSuffix(dest, p)).toBe('ref.txt')
    expect(await copyIntoWithSuffix(dest, p)).toBe('ref (2).txt')
    expect(await copyIntoWithSuffix(dest, p)).toBe('ref (3).txt')
    expect(await readFile(join(dest, 'ref.txt'), 'utf8')).toBe('one')
  })

  it('handles names without extension', async () => {
    const p = await makeOriginal('README', 'x')
    const dest = join(root, 'refs')
    await copyIntoWithSuffix(dest, p)
    expect(await copyIntoWithSuffix(dest, p)).toBe('README (2)')
  })
})
