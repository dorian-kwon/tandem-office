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
  removeGlossary,
  removeReference,
  removeSource,
} from './materials'
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
})

describe('glossary', () => {
  it('addGlossary writes normalized glossary.json', async () => {
    const p = await addGlossary(dir, await make('g.txt', '원어\t번역어\n사과\tapple\n'))
    expect(p.glossaryFiles).toEqual(['g.txt'])
    expect(await loadGlossary(dir)).toEqual([{ source: '사과', target: 'apple' }])
  })

  it('addGlossary with unreadable file leaves no copy in glossary/', async () => {
    await expect(addGlossary(dir, await make('g.docx', 'nope'))).rejects.toThrow()
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
    expect(await exists(join(dir, 'victim.txt'))).toBe(true)
  })
})
