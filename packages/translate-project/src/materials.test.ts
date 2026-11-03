import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NotListedError,
  addGlossary,
  addReference,
  addSource,
  loadGlossary,
  refreshReferences,
  removeGlossary,
  removeReference,
  removeSource,
} from './materials'
import { referenceStatuses } from './reference-index'
import { GlossaryFormatError } from './glossary'
import { createProject, loadProject } from './project-store'
import * as store from './project-store'

vi.mock('./project-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./project-store')>()
  return { ...actual, saveProject: vi.fn(actual.saveProject) }
})

let root: string
let dir: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'materials-'))
  dir = (await createProject(root, 'proj', 'ko', 'en')).dir
})

afterEach(async () => {
  vi.mocked(store.saveProject).mockClear()
  await rm(root, { recursive: true, force: true })
})

const make = async (name: string, text: string): Promise<string> => {
  const dirPath = join(root, 'originals')
  await mkdir(dirPath, { recursive: true })
  const p = join(dirPath, name)
  await writeFile(p, text, 'utf8')
  return p
}
const exists = async (p: string): Promise<boolean> => (await stat(p).catch(() => null)) !== null

describe('sources', () => {
  it('addSource copies the file and records it', async () => {
    const p = await addSource(dir, await make('a.txt', 'hello'))
    expect(p.sources.map((s) => s.file)).toEqual(['a.txt'])
    expect(await exists(join(dir, 'source', 'a.txt'))).toBe(true)
    expect((await loadProject(dir)).sources).toHaveLength(1)
  })

  it('removeSource keeps the translated copy in output/', async () => {
    await addSource(dir, await make('a.txt', 'hello'))
    await writeFile(join(dir, 'output', 'a.txt'), 'translated')
    const p = await removeSource(dir, 'a.txt')
    expect(p.sources).toEqual([])
    expect(await exists(join(dir, 'source', 'a.txt'))).toBe(false)
    expect(await readFile(join(dir, 'output', 'a.txt'), 'utf8')).toBe('translated')
  })
})

describe('re-adding a removed source', () => {
  it('gets a new name, so it never inherits the old translation in output/', async () => {
    await addSource(dir, await make('a.txt', 'hello'))
    await writeFile(join(dir, 'output', 'a.txt'), 'translated')
    await removeSource(dir, 'a.txt')
    const p = await addSource(dir, await make('a.txt', 'hello again'))
    expect(p.sources.map((s) => s.file)).toEqual(['a (2).txt'])
    expect(await readFile(join(dir, 'output', 'a.txt'), 'utf8')).toBe('translated')
  })

  it('references and glossaries do not look at output/', async () => {
    await writeFile(join(dir, 'output', 'r.txt'), 'x')
    await writeFile(join(dir, 'output', 'g.csv'), 'x')
    const p1 = await addReference(dir, await make('r.txt', 'ref'))
    expect(p1.references).toEqual(['r.txt'])
    const p2 = await addGlossary(dir, await make('g.csv', 'a,b'))
    expect(p2.glossaryFiles).toEqual(['g.csv'])
  })
})

describe('references', () => {
  it('adding a same-named reference twice keeps both', async () => {
    const orig = await make('ref.txt', 'x')
    await addReference(dir, orig)
    const p = await addReference(dir, orig)
    expect(p.references).toEqual(['ref.txt', 'ref (2).txt'])
    expect((await readdir(join(dir, 'references'))).sort()).toEqual(['ref (2).txt', 'ref.txt'])
  })

  it('removeReference deletes the copy and the entry', async () => {
    await addReference(dir, await make('ref.txt', 'x'))
    const p = await removeReference(dir, 'ref.txt')
    expect(p.references).toEqual([])
    expect(await readdir(join(dir, 'references'))).toEqual([])
  })

  it('cleans up the copy when saveProject fails', async () => {
    vi.mocked(store.saveProject).mockRejectedValueOnce(new Error('disk full'))
    await expect(addReference(dir, await make('ref.txt', 'x'))).rejects.toThrow('disk full')
    expect(await readdir(join(dir, 'references'))).toEqual([])
  })

  const asText = async (path: string) => ({ ok: true as const, md: await readFile(path, 'utf8') })

  it('converts and indexes a reference when it is added, and drops it when removed', async () => {
    await addReference(dir, await make('ref.txt', 'reference words'), { convert: asText })
    expect(await referenceStatuses(dir)).toEqual({ 'ref.txt': 'converted' })
    expect(await readFile(join(dir, 'references', '.md', 'ref.txt.md'), 'utf8')).toBe(
      'reference words',
    )
    await removeReference(dir, 'ref.txt', { convert: asText })
    expect(await referenceStatuses(dir)).toEqual({})
    expect(await exists(join(dir, 'references', '.md', 'ref.txt.md'))).toBe(false)
  })

  it('a failing conversion is recorded and never fails the add', async () => {
    const convert = async () => {
      throw new Error('parser crashed')
    }
    const p = await addReference(dir, await make('ref.docx', 'x'), { convert })
    expect(p.references).toEqual(['ref.docx'])
    expect(await referenceStatuses(dir)).toEqual({ 'ref.docx': 'failed' })
  })

  it('refreshReferences converts references added before the index existed', async () => {
    await addReference(dir, await make('old.txt', 'older words'))
    expect(await referenceStatuses(dir)).toEqual({})
    expect(await refreshReferences(dir, asText)).toEqual({ 'old.txt': 'converted' })
  })
})

describe('glossary', () => {
  it('addGlossary writes normalized glossary.json', async () => {
    const p = await addGlossary(dir, await make('g.txt', '원어\t번역어\n사과\tapple\n'))
    expect(p.glossaryFiles).toEqual(['g.txt'])
    expect(await loadGlossary(dir)).toEqual([{ source: '사과', target: 'apple' }])
  })

  it('addGlossary with unreadable file leaves no copy in glossary/', async () => {
    await expect(addGlossary(dir, await make('g.docx', 'nope'))).rejects.toBeInstanceOf(
      GlossaryFormatError,
    )
    expect(await readdir(join(dir, 'glossary'))).toEqual([])
    expect((await loadProject(dir)).glossaryFiles).toEqual([])
  })

  it('merges files in order and dedupes exact pairs, keeping differing targets', async () => {
    await addGlossary(dir, await make('a.txt', '사과\tapple\n배\tpear\n'))
    await addGlossary(dir, await make('b.txt', '사과\tapple\n사과\tAppleCo\n'))
    expect(await loadGlossary(dir)).toEqual([
      { source: '사과', target: 'apple' },
      { source: '배', target: 'pear' },
      { source: '사과', target: 'AppleCo' },
    ])
  })

  it('removeGlossary rebuilds merged glossary from remaining files', async () => {
    await addGlossary(dir, await make('a.txt', '사과\tapple\n'))
    await addGlossary(dir, await make('b.txt', '배\tpear\n'))
    await removeGlossary(dir, 'a.txt')
    expect(await loadGlossary(dir)).toEqual([{ source: '배', target: 'pear' }])
    const p = await removeGlossary(dir, 'b.txt')
    expect(p.glossaryFiles).toEqual([])
    expect(await loadGlossary(dir)).toEqual([])
    expect(await readdir(join(dir, 'glossary'))).toEqual([])
  })

  it('loadGlossary returns [] when glossary.json is missing', async () => {
    expect(await loadGlossary(dir)).toEqual([])
  })
})

describe('concurrency', () => {
  it('five parallel addReference calls keep every entry and file', async () => {
    const origs = await Promise.all([1, 2, 3, 4, 5].map((n) => make(`r${n}.txt`, String(n))))
    await Promise.all(origs.map((o) => addReference(dir, o)))
    const p = await loadProject(dir)
    expect([...p.references].sort()).toEqual(['r1.txt', 'r2.txt', 'r3.txt', 'r4.txt', 'r5.txt'])
    expect(await readdir(join(dir, 'references'))).toHaveLength(5)
  })

  it('mixed parallel add and remove calls keep all changes', async () => {
    await addReference(dir, await make('old.txt', 'x'))
    const src = await make('s.txt', 's')
    const gl = await make('g.txt', '사과\tapple\n')
    await Promise.all([addSource(dir, src), addGlossary(dir, gl), removeReference(dir, 'old.txt')])
    const p = await loadProject(dir)
    expect(p.sources.map((s) => s.file)).toEqual(['s.txt'])
    expect(p.glossaryFiles).toEqual(['g.txt'])
    expect(p.references).toEqual([])
    expect(await readdir(join(dir, 'references'))).toEqual([])
    expect(await loadGlossary(dir)).toEqual([{ source: '사과', target: 'apple' }])
  })
})

describe('rollback', () => {
  it('addSource removes the copy and keeps project.json when saveProject fails', async () => {
    const before = await readFile(join(dir, '.tandem', 'project.json'), 'utf8')
    vi.mocked(store.saveProject).mockRejectedValueOnce(new Error('disk full'))
    await expect(addSource(dir, await make('a.txt', 'x'))).rejects.toThrow('disk full')
    expect(await readdir(join(dir, 'source'))).toEqual([])
    expect(await readFile(join(dir, '.tandem', 'project.json'), 'utf8')).toBe(before)
  })

  it('addGlossary removes the copy and restores glossary.json when saveProject fails', async () => {
    await addGlossary(dir, await make('a.txt', '사과\tapple\n'))
    const before = await readFile(join(dir, '.tandem', 'project.json'), 'utf8')
    vi.mocked(store.saveProject).mockRejectedValueOnce(new Error('disk full'))
    await expect(addGlossary(dir, await make('b.txt', '배\tpear\n'))).rejects.toThrow('disk full')
    expect(await readdir(join(dir, 'glossary'))).toEqual(['a.txt'])
    expect(await readFile(join(dir, '.tandem', 'project.json'), 'utf8')).toBe(before)
    expect(await loadGlossary(dir)).toEqual([{ source: '사과', target: 'apple' }])
  })

  it('removeGlossary throws and changes nothing when another listed file is unreadable', async () => {
    await addGlossary(dir, await make('a.txt', '사과\tapple\n'))
    await addGlossary(dir, await make('b.txt', '배\tpear\n'))
    await rm(join(dir, 'glossary', 'b.txt'))
    const before = await readFile(join(dir, '.tandem', 'project.json'), 'utf8')
    const json = await readFile(join(dir, '.tandem', 'glossary.json'), 'utf8')
    await expect(removeGlossary(dir, 'a.txt')).rejects.toThrow()
    expect(await readFile(join(dir, '.tandem', 'project.json'), 'utf8')).toBe(before)
    expect(await readFile(join(dir, '.tandem', 'glossary.json'), 'utf8')).toBe(json)
    expect(await exists(join(dir, 'glossary', 'a.txt'))).toBe(true)
  })
})

describe('not listed', () => {
  it('removing a file that is not listed throws NotListedError and deletes nothing', async () => {
    await writeFile(join(dir, 'source', 'stray.txt'), 'x')
    await writeFile(join(dir, 'references', 'stray.txt'), 'x')
    await writeFile(join(dir, 'glossary', 'stray.txt'), 'x')
    await expect(removeSource(dir, 'stray.txt')).rejects.toBeInstanceOf(NotListedError)
    await expect(removeReference(dir, 'stray.txt')).rejects.toBeInstanceOf(NotListedError)
    await expect(removeGlossary(dir, 'stray.txt')).rejects.toBeInstanceOf(NotListedError)
    expect(await exists(join(dir, 'source', 'stray.txt'))).toBe(true)
    expect(await exists(join(dir, 'references', 'stray.txt'))).toBe(true)
    expect(await exists(join(dir, 'glossary', 'stray.txt'))).toBe(true)
  })

  it('rejects path traversal names before touching the file system', async () => {
    await writeFile(join(dir, 'victim.txt'), 'x')
    for (const bad of ['../victim.txt', '..', 'a/b', 'a\\b', '']) {
      await expect(removeReference(dir, bad)).rejects.toBeInstanceOf(NotListedError)
    }
    for (const bad of ['../victim.txt', 'a/b']) {
      await expect(removeSource(dir, bad)).rejects.toBeInstanceOf(NotListedError)
      await expect(removeGlossary(dir, bad)).rejects.toBeInstanceOf(NotListedError)
    }
    expect(await exists(join(dir, 'victim.txt'))).toBe(true)
  })
})
