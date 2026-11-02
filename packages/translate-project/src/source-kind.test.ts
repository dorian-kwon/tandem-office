import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NotListedError, addSource } from './materials'
import { createProject, loadProject } from './project-store'
import {
  InvalidSourceKindError,
  SourceChangedError,
  SourceKindChosenError,
  chosenSourceKind,
  setSourceKind,
} from './source-kind'

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

describe('setSourceKind with the hash it was decided for', () => {
  it('refuses when the entry changed since the kind was decided', async () => {
    await addPdf('a.pdf')
    await expect(
      setSourceKind(dir, 'a.pdf', 'scan', { expectedSha256: 'not-the-hash' }),
    ).rejects.toBeInstanceOf(SourceChangedError)
    expect((await loadProject(dir)).sources[0]?.kind).toBe('pdf')
  })

  it('writes when the hash still matches', async () => {
    await addPdf('a.pdf')
    const { sha256 } = (await loadProject(dir)).sources[0]!
    const next = await setSourceKind(dir, 'a.pdf', 'scan', { expectedSha256: sha256 })
    expect(next.sources[0]?.kind).toBe('scan')
  })
})

describe('the person’s own choice of kind', () => {
  it('is remembered for that copy and read back', async () => {
    await addPdf('a.pdf')
    const { sha256 } = (await loadProject(dir)).sources[0]!
    expect(await chosenSourceKind(dir, 'a.pdf', sha256)).toBeNull()
    await setSourceKind(dir, 'a.pdf', 'pdf', { expectedSha256: sha256, chosenByPerson: true })
    expect(await chosenSourceKind(dir, 'a.pdf', sha256)).toBe('pdf')
    await setSourceKind(dir, 'a.pdf', 'scan', { expectedSha256: sha256, chosenByPerson: true })
    expect(await chosenSourceKind(dir, 'a.pdf', sha256)).toBe('scan')
  })

  it('does not carry over to another copy under the same name', async () => {
    await addPdf('a.pdf')
    const { sha256 } = (await loadProject(dir)).sources[0]!
    await setSourceKind(dir, 'a.pdf', 'pdf', { chosenByPerson: true })
    expect(await chosenSourceKind(dir, 'a.pdf', 'other-hash')).toBeNull()
    expect(await chosenSourceKind(dir, 'a.pdf', sha256)).toBe('pdf')
  })

  it('an automatic change records no choice', async () => {
    await addPdf('a.pdf')
    const { sha256 } = (await loadProject(dir)).sources[0]!
    await setSourceKind(dir, 'a.pdf', 'scan')
    expect(await chosenSourceKind(dir, 'a.pdf', sha256)).toBeNull()
  })

  it('a damaged choices file reads as no choice', async () => {
    await addPdf('a.pdf')
    const { sha256 } = (await loadProject(dir)).sources[0]!
    await mkdir(join(dir, '.tandem'), { recursive: true })
    await writeFile(join(dir, '.tandem', 'source-kinds.json'), '{not json', 'utf8')
    expect(await chosenSourceKind(dir, 'a.pdf', sha256)).toBeNull()
    await setSourceKind(dir, 'a.pdf', 'pdf', { chosenByPerson: true })
    expect(await chosenSourceKind(dir, 'a.pdf', sha256)).toBe('pdf')
  })
})

describe('the choice is protected', () => {
  it('an automatic change is refused once the person chose for that copy', async () => {
    await addPdf('a.pdf')
    const { sha256 } = (await loadProject(dir)).sources[0]!
    await setSourceKind(dir, 'a.pdf', 'pdf', { chosenByPerson: true })
    await expect(
      setSourceKind(dir, 'a.pdf', 'scan', { expectedSha256: sha256 }),
    ).rejects.toBeInstanceOf(SourceKindChosenError)
    expect((await loadProject(dir)).sources[0]?.kind).toBe('pdf')
    // the person can still change it
    await setSourceKind(dir, 'a.pdf', 'scan', { chosenByPerson: true })
    expect((await loadProject(dir)).sources[0]?.kind).toBe('scan')
  })

  it('project.json is written before the choices file', async () => {
    await addPdf('a.pdf')
    // the choices file cannot be written: a folder stands where its temp file goes
    await mkdir(join(dir, '.tandem'), { recursive: true })
    await mkdir(join(dir, '.tandem', 'source-kinds.json'), { recursive: true })
    await expect(setSourceKind(dir, 'a.pdf', 'scan', { chosenByPerson: true })).rejects.toThrow()
    expect((await loadProject(dir)).sources[0]?.kind).toBe('scan')
  })

  it('a __proto__ key in the choices file is ignored', async () => {
    await addPdf('a.pdf')
    const { sha256 } = (await loadProject(dir)).sources[0]!
    await mkdir(join(dir, '.tandem'), { recursive: true })
    await writeFile(
      join(dir, '.tandem', 'source-kinds.json'),
      `{"version":1,"chosen":{"__proto__":{"sha256":"${sha256}","kind":"scan"},"a.pdf":{"sha256":"${sha256}","kind":"pdf"}}}`,
      'utf8',
    )
    expect(await chosenSourceKind(dir, '__proto__', sha256)).toBeNull()
    expect(await chosenSourceKind(dir, 'a.pdf', sha256)).toBe('pdf')
    expect(({} as Record<string, unknown>).sha256).toBeUndefined()
    // writing keeps it out
    await setSourceKind(dir, 'a.pdf', 'scan', { chosenByPerson: true })
    const raw = await readFile(join(dir, '.tandem', 'source-kinds.json'), 'utf8')
    expect(raw).not.toContain('__proto__')
  })
})
