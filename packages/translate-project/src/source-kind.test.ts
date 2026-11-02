import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NotListedError, addSource } from './materials'
import { createProject, loadProject } from './project-store'
import { InvalidSourceKindError, setSourceKind } from './source-kind'

let root: string
let dir: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'source-kind-'))
  dir = (await createProject(root, 'proj', 'en', 'ko')).dir
  await mkdir(join(root, 'originals'), { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function addPdf(name: string): Promise<void> {
  const p = join(root, 'originals', name)
  await writeFile(p, '%PDF-1.4\n', 'utf8')
  await addSource(dir, p)
}

describe('setSourceKind', () => {
  it('changes the kind of a listed source and saves it', async () => {
    await addPdf('a.pdf')
    const next = await setSourceKind(dir, 'a.pdf', 'scan')
    expect(next.sources[0]?.kind).toBe('scan')
    expect((await loadProject(dir)).sources[0]?.kind).toBe('scan')
  })

  it('keeps the file name and hash of the entry', async () => {
    await addPdf('a.pdf')
    const before = (await loadProject(dir)).sources[0]!
    await setSourceKind(dir, 'a.pdf', 'scan')
    const after = (await loadProject(dir)).sources[0]!
    expect(after.file).toBe(before.file)
    expect(after.sha256).toBe(before.sha256)
  })

  it('leaves the other sources alone', async () => {
    await addPdf('a.pdf')
    await addPdf('b.pdf')
    await setSourceKind(dir, 'b.pdf', 'scan')
    const kinds = (await loadProject(dir)).sources.map((s) => [s.file, s.kind])
    expect(kinds).toEqual([
      ['a.pdf', 'pdf'],
      ['b.pdf', 'scan'],
    ])
  })

  it('refuses a file that is not listed', async () => {
    await expect(setSourceKind(dir, 'nope.pdf', 'scan')).rejects.toBeInstanceOf(NotListedError)
  })

  it('refuses a path instead of a plain name', async () => {
    await addPdf('a.pdf')
    await expect(setSourceKind(dir, '../a.pdf', 'scan')).rejects.toBeInstanceOf(NotListedError)
  })

  it('refuses a kind that is not a source kind', async () => {
    await addPdf('a.pdf')
    await expect(setSourceKind(dir, 'a.pdf', 'docx' as never)).rejects.toBeInstanceOf(
      InvalidSourceKindError,
    )
    expect((await loadProject(dir)).sources[0]?.kind).toBe('pdf')
  })

  it('does not write when the kind is already the same', async () => {
    await addPdf('a.pdf')
    const before = await loadProject(dir)
    const next = await setSourceKind(dir, 'a.pdf', 'pdf')
    expect(next).toEqual(before)
  })

  it('runs under the project lock: concurrent changes all survive', async () => {
    await addPdf('a.pdf')
    const p = join(root, 'originals', 'c.pdf')
    await writeFile(p, '%PDF-1.4\n', 'utf8')
    await Promise.all([setSourceKind(dir, 'a.pdf', 'scan'), addSource(dir, p)])
    const project = await loadProject(dir)
    expect(project.sources.map((s) => [s.file, s.kind])).toEqual([
      ['a.pdf', 'scan'],
      ['c.pdf', 'pdf'],
    ])
  })
})
